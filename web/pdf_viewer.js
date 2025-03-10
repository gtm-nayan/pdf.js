/* Copyright 2014 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** @typedef {import("../src/display/api").PDFDocumentProxy} PDFDocumentProxy */
/** @typedef {import("../src/display/api").PDFPageProxy} PDFPageProxy */
// eslint-disable-next-line max-len
/** @typedef {import("../src/display/display_utils").PageViewport} PageViewport */
// eslint-disable-next-line max-len
/** @typedef {import("../src/display/optional_content_config").OptionalContentConfig} OptionalContentConfig */
/** @typedef {import("./event_utils").EventBus} EventBus */
/** @typedef {import("./interfaces").IDownloadManager} IDownloadManager */
/** @typedef {import("./interfaces").IL10n} IL10n */
// eslint-disable-next-line max-len
/** @typedef {import("./interfaces").IPDFAnnotationLayerFactory} IPDFAnnotationLayerFactory */
// eslint-disable-next-line max-len
/** @typedef {import("./interfaces").IPDFAnnotationEditorLayerFactory} IPDFAnnotationEditorLayerFactory */
/** @typedef {import("./interfaces").IPDFLinkService} IPDFLinkService */
// eslint-disable-next-line max-len
/** @typedef {import("./interfaces").IPDFStructTreeLayerFactory} IPDFStructTreeLayerFactory */
// eslint-disable-next-line max-len
/** @typedef {import("./interfaces").IPDFTextLayerFactory} IPDFTextLayerFactory */
/** @typedef {import("./interfaces").IPDFXfaLayerFactory} IPDFXfaLayerFactory */
// eslint-disable-next-line max-len
/** @typedef {import("./text_accessibility.js").TextAccessibilityManager} TextAccessibilityManager */

import {
  AnnotationEditorType,
  AnnotationEditorUIManager,
  AnnotationMode,
  createPromiseCapability,
  PermissionFlag,
  PixelsPerInch,
  version,
} from "pdfjs-lib";
import {
  DEFAULT_SCALE,
  DEFAULT_SCALE_DELTA,
  DEFAULT_SCALE_VALUE,
  docStyle,
  getVisibleElements,
  isPortraitOrientation,
  isValidRotation,
  isValidScrollMode,
  isValidSpreadMode,
  MAX_AUTO_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  PresentationModeState,
  RendererType,
  RenderingStates,
  SCROLLBAR_PADDING,
  scrollIntoView,
  ScrollMode,
  SpreadMode,
  TextLayerMode,
  UNKNOWN_SCALE,
  VERTICAL_PADDING,
  watchScroll,
} from "./ui_utils.js";
import { AnnotationEditorLayerBuilder } from "./annotation_editor_layer_builder.js";
import { AnnotationLayerBuilder } from "./annotation_layer_builder.js";
import { NullL10n } from "./l10n_utils.js";
import { PDFPageView } from "./pdf_page_view.js";
import { PDFRenderingQueue } from "./pdf_rendering_queue.js";
import { SimpleLinkService } from "./pdf_link_service.js";
import { StructTreeLayerBuilder } from "./struct_tree_layer_builder.js";
import { TextHighlighter } from "./text_highlighter.js";
import { TextLayerBuilder } from "./text_layer_builder.js";
import { XfaLayerBuilder } from "./xfa_layer_builder.js";

const DEFAULT_CACHE_SIZE = 10;
const ENABLE_PERMISSIONS_CLASS = "enablePermissions";

const PagesCountLimit = {
  FORCE_SCROLL_MODE_PAGE: 15000,
  FORCE_LAZY_PAGE_INIT: 7500,
  PAUSE_EAGER_PAGE_INIT: 250,
};

function isValidAnnotationEditorMode(mode) {
  return (
    Object.values(AnnotationEditorType).includes(mode) &&
    mode !== AnnotationEditorType.DISABLE
  );
}

/**
 * @typedef {Object} PDFViewerOptions
 * @property {HTMLDivElement} container - The container for the viewer element.
 * @property {HTMLDivElement} [viewer] - The viewer element.
 * @property {EventBus} eventBus - The application event bus.
 * @property {IPDFLinkService} linkService - The navigation/linking service.
 * @property {IDownloadManager} [downloadManager] - The download manager
 *   component.
 * @property {PDFFindController} [findController] - The find controller
 *   component.
 * @property {PDFScriptingManager} [scriptingManager] - The scripting manager
 *   component.
 * @property {PDFRenderingQueue} [renderingQueue] - The rendering queue object.
 * @property {boolean} [removePageBorders] - Removes the border shadow around
 *   the pages. The default value is `false`.
 * @property {number} [textLayerMode] - Controls if the text layer used for
 *   selection and searching is created. The constants from {TextLayerMode}
 *   should be used. The default value is `TextLayerMode.ENABLE`.
 * @property {number} [annotationMode] - Controls if the annotation layer is
 *   created, and if interactive form elements or `AnnotationStorage`-data are
 *   being rendered. The constants from {@link AnnotationMode} should be used;
 *   see also {@link RenderParameters} and {@link GetOperatorListParameters}.
 *   The default value is `AnnotationMode.ENABLE_FORMS`.
 * @property {number} [annotationEditorMode] - Enables the creation and editing
 *   of new Annotations. The constants from {@link AnnotationEditorType} should
 *   be used. The default value is `AnnotationEditorType.NONE`.
 * @property {string} [imageResourcesPath] - Path for image resources, mainly
 *   mainly for annotation icons. Include trailing slash.
 * @property {boolean} [enablePrintAutoRotate] - Enables automatic rotation of
 *   landscape pages upon printing. The default is `false`.
 * @property {boolean} [useOnlyCssZoom] - Enables CSS only zooming. The default
 *   value is `false`.
 * @property {boolean} [isOffscreenCanvasSupported] - Allows to use an
 *   OffscreenCanvas if needed.
 * @property {number} [maxCanvasPixels] - The maximum supported canvas size in
 *   total pixels, i.e. width * height. Use -1 for no limit. The default value
 *   is 4096 * 4096 (16 mega-pixels).
 * @property {IL10n} l10n - Localization service.
 * @property {boolean} [enablePermissions] - Enables PDF document permissions,
 *   when they exist. The default value is `false`.
 * @property {Object} [pageColors] - Overwrites background and foreground colors
 *   with user defined ones in order to improve readability in high contrast
 *   mode.
 */

class PDFPageViewBuffer {
  // Here we rely on the fact that `Set`s preserve the insertion order.
  #buf = new Set();

  #size = 0;

  constructor(size) {
    this.#size = size;
  }

  push(view) {
    const buf = this.#buf;
    if (buf.has(view)) {
      buf.delete(view); // Move the view to the "end" of the buffer.
    }
    buf.add(view);

    if (buf.size > this.#size) {
      this.#destroyFirstView();
    }
  }

  /**
   * After calling resize, the size of the buffer will be `newSize`.
   * The optional parameter `idsToKeep` is, if present, a Set of page-ids to
   * push to the back of the buffer, delaying their destruction. The size of
   * `idsToKeep` has no impact on the final size of the buffer; if `idsToKeep`
   * is larger than `newSize`, some of those pages will be destroyed anyway.
   */
  resize(newSize, idsToKeep = null) {
    this.#size = newSize;

    const buf = this.#buf;
    if (idsToKeep) {
      const ii = buf.size;
      let i = 1;
      for (const view of buf) {
        if (idsToKeep.has(view.id)) {
          buf.delete(view); // Move the view to the "end" of the buffer.
          buf.add(view);
        }
        if (++i > ii) {
          break;
        }
      }
    }

    while (buf.size > this.#size) {
      this.#destroyFirstView();
    }
  }

  has(view) {
    return this.#buf.has(view);
  }

  [Symbol.iterator]() {
    return this.#buf.keys();
  }

  #destroyFirstView() {
    const firstView = this.#buf.keys().next().value;

    firstView?.destroy();
    this.#buf.delete(firstView);
  }
}

/**
 * Simple viewer control to display PDF content/pages.
 *
 * @implements {IPDFAnnotationLayerFactory}
 * @implements {IPDFAnnotationEditorLayerFactory}
 * @implements {IPDFStructTreeLayerFactory}
 * @implements {IPDFTextLayerFactory}
 * @implements {IPDFXfaLayerFactory}
 */
class PDFViewer {
  #buffer = null;

  #annotationEditorMode = AnnotationEditorType.NONE;

  #annotationEditorUIManager = null;

  #annotationMode = AnnotationMode.ENABLE_FORMS;

  #enablePermissions = false;

  #previousContainerHeight = 0;

  #scrollModePageState = null;

  #onVisibilityChange = null;

  /**
   * @param {PDFViewerOptions} options
   */
  constructor(options) {
    const viewerVersion =
      typeof PDFJSDev !== "undefined" ? PDFJSDev.eval("BUNDLE_VERSION") : null;
    if (version !== viewerVersion) {
      throw new Error(
        `The API version "${version}" does not match the Viewer version "${viewerVersion}".`
      );
    }
    this.container = options.container;
    this.viewer = options.viewer || options.container.firstElementChild;

    if (
      typeof PDFJSDev === "undefined" ||
      PDFJSDev.test("!PRODUCTION || GENERIC")
    ) {
      if (
        !(
          this.container?.tagName.toUpperCase() === "DIV" &&
          this.viewer?.tagName.toUpperCase() === "DIV"
        )
      ) {
        throw new Error("Invalid `container` and/or `viewer` option.");
      }

      if (
        this.container.offsetParent &&
        getComputedStyle(this.container).position !== "absolute"
      ) {
        throw new Error("The `container` must be absolutely positioned.");
      }
    }
    this.eventBus = options.eventBus;
    this.linkService = options.linkService || new SimpleLinkService();
    this.downloadManager = options.downloadManager || null;
    this.findController = options.findController || null;
    this._scriptingManager = options.scriptingManager || null;
    this.removePageBorders = options.removePageBorders || false;
    this.textLayerMode = options.textLayerMode ?? TextLayerMode.ENABLE;
    this.#annotationMode =
      options.annotationMode ?? AnnotationMode.ENABLE_FORMS;
    this.#annotationEditorMode =
      options.annotationEditorMode ?? AnnotationEditorType.NONE;
    this.imageResourcesPath = options.imageResourcesPath || "";
    this.enablePrintAutoRotate = options.enablePrintAutoRotate || false;
    if (
      typeof PDFJSDev === "undefined" ||
      PDFJSDev.test("!PRODUCTION || GENERIC")
    ) {
      this.renderer = options.renderer || RendererType.CANVAS;
    }
    this.useOnlyCssZoom = options.useOnlyCssZoom || false;
    this.isOffscreenCanvasSupported =
      options.isOffscreenCanvasSupported ?? true;
    this.maxCanvasPixels = options.maxCanvasPixels;
    this.l10n = options.l10n || NullL10n;
    this.#enablePermissions = options.enablePermissions || false;
    this.pageColors = options.pageColors || null;

    if (typeof PDFJSDev === "undefined" || !PDFJSDev.test("MOZCENTRAL")) {
      if (
        this.pageColors &&
        !(
          CSS.supports("color", this.pageColors.background) &&
          CSS.supports("color", this.pageColors.foreground)
        )
      ) {
        if (this.pageColors.background || this.pageColors.foreground) {
          console.warn(
            "PDFViewer: Ignoring `pageColors`-option, since the browser doesn't support the values used."
          );
        }
        this.pageColors = null;
      }
    }

    this.defaultRenderingQueue = !options.renderingQueue;
    if (this.defaultRenderingQueue) {
      // Custom rendering queue is not specified, using default one
      this.renderingQueue = new PDFRenderingQueue();
      this.renderingQueue.setViewer(this);
    } else {
      this.renderingQueue = options.renderingQueue;
    }

    this.scroll = watchScroll(this.container, this._scrollUpdate.bind(this));
    this.presentationModeState = PresentationModeState.UNKNOWN;
    this._onBeforeDraw = this._onAfterDraw = null;
    this._resetView();

    if (this.removePageBorders) {
      this.viewer.classList.add("removePageBorders");
    }
    this.updateContainerHeightCss();
  }

  get pagesCount() {
    return this._pages.length;
  }

  getPageView(index) {
    return this._pages[index];
  }

  /**
   * @type {boolean} - True if all {PDFPageView} objects are initialized.
   */
  get pageViewsReady() {
    if (!this._pagesCapability.settled) {
      return false;
    }
    // Prevent printing errors when 'disableAutoFetch' is set, by ensuring
    // that *all* pages have in fact been completely loaded.
    return this._pages.every(function (pageView) {
      return pageView?.pdfPage;
    });
  }

  /**
   * @type {boolean}
   */
  get renderForms() {
    return this.#annotationMode === AnnotationMode.ENABLE_FORMS;
  }

  /**
   * @type {boolean}
   */
  get enableScripting() {
    return !!this._scriptingManager;
  }

  /**
   * @type {number}
   */
  get currentPageNumber() {
    return this._currentPageNumber;
  }

  /**
   * @param {number} val - The page number.
   */
  set currentPageNumber(val) {
    if (!Number.isInteger(val)) {
      throw new Error("Invalid page number.");
    }
    if (!this.pdfDocument) {
      return;
    }
    // The intent can be to just reset a scroll position and/or scale.
    if (!this._setCurrentPageNumber(val, /* resetCurrentPageView = */ true)) {
      console.error(`currentPageNumber: "${val}" is not a valid page.`);
    }
  }

  /**
   * @returns {boolean} Whether the pageNumber is valid (within bounds).
   * @private
   */
  _setCurrentPageNumber(val, resetCurrentPageView = false) {
    if (this._currentPageNumber === val) {
      if (resetCurrentPageView) {
        this.#resetCurrentPageView();
      }
      return true;
    }

    if (!(0 < val && val <= this.pagesCount)) {
      return false;
    }
    const previous = this._currentPageNumber;
    this._currentPageNumber = val;

    this.eventBus.dispatch("pagechanging", {
      source: this,
      pageNumber: val,
      pageLabel: this._pageLabels?.[val - 1] ?? null,
      previous,
    });

    if (resetCurrentPageView) {
      this.#resetCurrentPageView();
    }
    return true;
  }

  /**
   * @type {string|null} Returns the current page label, or `null` if no page
   *   labels exist.
   */
  get currentPageLabel() {
    return this._pageLabels?.[this._currentPageNumber - 1] ?? null;
  }

  /**
   * @param {string} val - The page label.
   */
  set currentPageLabel(val) {
    if (!this.pdfDocument) {
      return;
    }
    let page = val | 0; // Fallback page number.
    if (this._pageLabels) {
      const i = this._pageLabels.indexOf(val);
      if (i >= 0) {
        page = i + 1;
      }
    }
    // The intent can be to just reset a scroll position and/or scale.
    if (!this._setCurrentPageNumber(page, /* resetCurrentPageView = */ true)) {
      console.error(`currentPageLabel: "${val}" is not a valid page.`);
    }
  }

  /**
   * @type {number}
   */
  get currentScale() {
    return this._currentScale !== UNKNOWN_SCALE
      ? this._currentScale
      : DEFAULT_SCALE;
  }

  /**
   * @param {number} val - Scale of the pages in percents.
   */
  set currentScale(val) {
    if (isNaN(val)) {
      throw new Error("Invalid numeric scale.");
    }
    if (!this.pdfDocument) {
      return;
    }
    this._setScale(val, false);
  }

  /**
   * @type {string}
   */
  get currentScaleValue() {
    return this._currentScaleValue;
  }

  /**
   * @param val - The scale of the pages (in percent or predefined value).
   */
  set currentScaleValue(val) {
    if (!this.pdfDocument) {
      return;
    }
    this._setScale(val, false);
  }

  /**
   * @type {number}
   */
  get pagesRotation() {
    return this._pagesRotation;
  }

  /**
   * @param {number} rotation - The rotation of the pages (0, 90, 180, 270).
   */
  set pagesRotation(rotation) {
    if (!isValidRotation(rotation)) {
      throw new Error("Invalid pages rotation angle.");
    }
    if (!this.pdfDocument) {
      return;
    }
    // Normalize the rotation, by clamping it to the [0, 360) range.
    rotation %= 360;
    if (rotation < 0) {
      rotation += 360;
    }
    if (this._pagesRotation === rotation) {
      return; // The rotation didn't change.
    }
    this._pagesRotation = rotation;

    const pageNumber = this._currentPageNumber;

    const updateArgs = { rotation };
    for (const pageView of this._pages) {
      pageView.update(updateArgs);
    }
    // Prevent errors in case the rotation changes *before* the scale has been
    // set to a non-default value.
    if (this._currentScaleValue) {
      this._setScale(this._currentScaleValue, true);
    }

    this.eventBus.dispatch("rotationchanging", {
      source: this,
      pagesRotation: rotation,
      pageNumber,
    });

    if (this.defaultRenderingQueue) {
      this.update();
    }
  }

  get firstPagePromise() {
    return this.pdfDocument ? this._firstPageCapability.promise : null;
  }

  get onePageRendered() {
    return this.pdfDocument ? this._onePageRenderedCapability.promise : null;
  }

  get pagesPromise() {
    return this.pdfDocument ? this._pagesCapability.promise : null;
  }

  /**
   * Currently only *some* permissions are supported.
   * @returns {Object}
   */
  #initializePermissions(permissions) {
    const params = {
      annotationEditorMode: this.#annotationEditorMode,
      annotationMode: this.#annotationMode,
      textLayerMode: this.textLayerMode,
    };
    if (!permissions) {
      return params;
    }

    if (!permissions.includes(PermissionFlag.COPY)) {
      this.viewer.classList.add(ENABLE_PERMISSIONS_CLASS);
    }

    if (!permissions.includes(PermissionFlag.MODIFY_CONTENTS)) {
      params.annotationEditorMode = AnnotationEditorType.DISABLE;
    }

    if (
      !permissions.includes(PermissionFlag.MODIFY_ANNOTATIONS) &&
      !permissions.includes(PermissionFlag.FILL_INTERACTIVE_FORMS) &&
      this.#annotationMode === AnnotationMode.ENABLE_FORMS
    ) {
      params.annotationMode = AnnotationMode.ENABLE;
    }

    return params;
  }

  #onePageRenderedOrForceFetch() {
    // Unless the viewer *and* its pages are visible, rendering won't start and
    // `this._onePageRenderedCapability` thus won't be resolved.
    // To ensure that automatic printing, on document load, still works even in
    // those cases we force-allow fetching of all pages when:
    //  - The current window/tab is inactive, which will prevent rendering since
    //    `requestAnimationFrame` is being used; fixes bug 1746213.
    //  - The viewer is hidden in the DOM, e.g. in a `display: none` <iframe>
    //    element; fixes bug 1618621.
    //  - The viewer is visible, but none of the pages are (e.g. if the
    //    viewer is very small); fixes bug 1618955.
    if (
      document.visibilityState === "hidden" ||
      !this.container.offsetParent ||
      this._getVisiblePages().views.length === 0
    ) {
      return Promise.resolve();
    }

    // Handle the window/tab becoming inactive *after* rendering has started;
    // fixes (another part of) bug 1746213.
    const visibilityChangePromise = new Promise(resolve => {
      this.#onVisibilityChange = () => {
        if (document.visibilityState !== "hidden") {
          return;
        }
        resolve();

        document.removeEventListener(
          "visibilitychange",
          this.#onVisibilityChange
        );
        this.#onVisibilityChange = null;
      };
      document.addEventListener("visibilitychange", this.#onVisibilityChange);
    });

    return Promise.race([
      this._onePageRenderedCapability.promise,
      visibilityChangePromise,
    ]);
  }

  /**
   * @param {PDFDocumentProxy} pdfDocument
   */
  setDocument(pdfDocument) {
    if (this.pdfDocument) {
      this.eventBus.dispatch("pagesdestroy", { source: this });

      this._cancelRendering();
      this._resetView();

      this.findController?.setDocument(null);
      this._scriptingManager?.setDocument(null);

      if (this.#annotationEditorUIManager) {
        this.#annotationEditorUIManager.destroy();
        this.#annotationEditorUIManager = null;
      }
    }

    this.pdfDocument = pdfDocument;
    if (!pdfDocument) {
      return;
    }
    const isPureXfa = pdfDocument.isPureXfa;
    const pagesCount = pdfDocument.numPages;
    const firstPagePromise = pdfDocument.getPage(1);
    // Rendering (potentially) depends on this, hence fetching it immediately.
    const optionalContentConfigPromise = pdfDocument.getOptionalContentConfig();
    const permissionsPromise = this.#enablePermissions
      ? pdfDocument.getPermissions()
      : Promise.resolve();

    // Given that browsers don't handle huge amounts of DOM-elements very well,
    // enforce usage of PAGE-scrolling when loading *very* long/large documents.
    if (pagesCount > PagesCountLimit.FORCE_SCROLL_MODE_PAGE) {
      console.warn(
        "Forcing PAGE-scrolling for performance reasons, given the length of the document."
      );
      const mode = (this._scrollMode = ScrollMode.PAGE);
      this.eventBus.dispatch("scrollmodechanged", { source: this, mode });
    }

    this._pagesCapability.promise.then(
      () => {
        this.eventBus.dispatch("pagesloaded", { source: this, pagesCount });
      },
      () => {
        /* Prevent "Uncaught (in promise)"-messages in the console. */
      }
    );

    this._onBeforeDraw = evt => {
      const pageView = this._pages[evt.pageNumber - 1];
      if (!pageView) {
        return;
      }
      // Add the page to the buffer at the start of drawing. That way it can be
      // evicted from the buffer and destroyed even if we pause its rendering.
      this.#buffer.push(pageView);
    };
    this.eventBus._on("pagerender", this._onBeforeDraw);

    this._onAfterDraw = evt => {
      if (evt.cssTransform || this._onePageRenderedCapability.settled) {
        return;
      }
      this._onePageRenderedCapability.resolve({ timestamp: evt.timestamp });

      this.eventBus._off("pagerendered", this._onAfterDraw);
      this._onAfterDraw = null;

      if (this.#onVisibilityChange) {
        document.removeEventListener(
          "visibilitychange",
          this.#onVisibilityChange
        );
        this.#onVisibilityChange = null;
      }
    };
    this.eventBus._on("pagerendered", this._onAfterDraw);

    // Fetch a single page so we can get a viewport that will be the default
    // viewport for all pages
    Promise.all([firstPagePromise, permissionsPromise])
      .then(([firstPdfPage, permissions]) => {
        if (pdfDocument !== this.pdfDocument) {
          return; // The document was closed while the first page resolved.
        }
        this._firstPageCapability.resolve(firstPdfPage);
        this._optionalContentConfigPromise = optionalContentConfigPromise;

        const { annotationEditorMode, annotationMode, textLayerMode } =
          this.#initializePermissions(permissions);

        if (annotationEditorMode !== AnnotationEditorType.DISABLE) {
          const mode = annotationEditorMode;

          if (isPureXfa) {
            console.warn("Warning: XFA-editing is not implemented.");
          } else if (isValidAnnotationEditorMode(mode)) {
            this.#annotationEditorUIManager = new AnnotationEditorUIManager(
              this.container,
              this.eventBus,
              this.pdfDocument?.annotationStorage
            );
            if (mode !== AnnotationEditorType.NONE) {
              this.#annotationEditorUIManager.updateMode(mode);
            }
          } else {
            console.error(`Invalid AnnotationEditor mode: ${mode}`);
          }
        }

        const viewerElement =
          this._scrollMode === ScrollMode.PAGE ? null : this.viewer;
        const scale = this.currentScale;
        const viewport = firstPdfPage.getViewport({
          scale: scale * PixelsPerInch.PDF_TO_CSS_UNITS,
        });
        // Ensure that the various layers always get the correct initial size,
        // see issue 15795.
        docStyle.setProperty("--scale-factor", viewport.scale);

        const textLayerFactory =
          textLayerMode !== TextLayerMode.DISABLE && !isPureXfa ? this : null;
        const annotationLayerFactory =
          annotationMode !== AnnotationMode.DISABLE ? this : null;
        const xfaLayerFactory = isPureXfa ? this : null;
        const annotationEditorLayerFactory = this.#annotationEditorUIManager
          ? this
          : null;

        for (let pageNum = 1; pageNum <= pagesCount; ++pageNum) {
          const pageView = new PDFPageView({
            container: viewerElement,
            eventBus: this.eventBus,
            id: pageNum,
            scale,
            defaultViewport: viewport.clone(),
            optionalContentConfigPromise,
            renderingQueue: this.renderingQueue,
            textLayerFactory,
            textLayerMode,
            annotationLayerFactory,
            annotationMode,
            xfaLayerFactory,
            annotationEditorLayerFactory,
            textHighlighterFactory: this,
            structTreeLayerFactory: this,
            imageResourcesPath: this.imageResourcesPath,
            renderer:
              typeof PDFJSDev === "undefined" ||
              PDFJSDev.test("!PRODUCTION || GENERIC")
                ? this.renderer
                : null,
            useOnlyCssZoom: this.useOnlyCssZoom,
            isOffscreenCanvasSupported: this.isOffscreenCanvasSupported,
            maxCanvasPixels: this.maxCanvasPixels,
            pageColors: this.pageColors,
            l10n: this.l10n,
          });
          this._pages.push(pageView);
        }
        // Set the first `pdfPage` immediately, since it's already loaded,
        // rather than having to repeat the `PDFDocumentProxy.getPage` call in
        // the `this.#ensurePdfPageLoaded` method before rendering can start.
        const firstPageView = this._pages[0];
        if (firstPageView) {
          firstPageView.setPdfPage(firstPdfPage);
          this.linkService.cachePageRef(1, firstPdfPage.ref);
        }

        if (this._scrollMode === ScrollMode.PAGE) {
          // Ensure that the current page becomes visible on document load.
          this.#ensurePageViewVisible();
        } else if (this._spreadMode !== SpreadMode.NONE) {
          this._updateSpreadMode();
        }

        // Fetch all the pages since the viewport is needed before printing
        // starts to create the correct size canvas. Wait until one page is
        // rendered so we don't tie up too many resources early on.
        this.#onePageRenderedOrForceFetch().then(async () => {
          this.findController?.setDocument(pdfDocument); // Enable searching.
          this._scriptingManager?.setDocument(pdfDocument); // Enable scripting.

          if (this.#annotationEditorUIManager) {
            // Ensure that the Editor buttons, in the toolbar, are updated.
            this.eventBus.dispatch("annotationeditormodechanged", {
              source: this,
              mode: this.#annotationEditorMode,
            });
          }

          // In addition to 'disableAutoFetch' being set, also attempt to reduce
          // resource usage when loading *very* long/large documents.
          if (
            pdfDocument.loadingParams.disableAutoFetch ||
            pagesCount > PagesCountLimit.FORCE_LAZY_PAGE_INIT
          ) {
            // XXX: Printing is semi-broken with auto fetch disabled.
            this._pagesCapability.resolve();
            return;
          }
          let getPagesLeft = pagesCount - 1; // The first page was already loaded.

          if (getPagesLeft <= 0) {
            this._pagesCapability.resolve();
            return;
          }
          for (let pageNum = 2; pageNum <= pagesCount; ++pageNum) {
            const promise = pdfDocument.getPage(pageNum).then(
              pdfPage => {
                const pageView = this._pages[pageNum - 1];
                if (!pageView.pdfPage) {
                  pageView.setPdfPage(pdfPage);
                }
                this.linkService.cachePageRef(pageNum, pdfPage.ref);
                if (--getPagesLeft === 0) {
                  this._pagesCapability.resolve();
                }
              },
              reason => {
                console.error(
                  `Unable to get page ${pageNum} to initialize viewer`,
                  reason
                );
                if (--getPagesLeft === 0) {
                  this._pagesCapability.resolve();
                }
              }
            );

            if (pageNum % PagesCountLimit.PAUSE_EAGER_PAGE_INIT === 0) {
              await promise;
            }
          }
        });

        this.eventBus.dispatch("pagesinit", { source: this });

        pdfDocument.getMetadata().then(({ info }) => {
          if (pdfDocument !== this.pdfDocument) {
            return; // The document was closed while the metadata resolved.
          }
          if (info.Language) {
            this.viewer.lang = info.Language;
          }
        });

        if (this.defaultRenderingQueue) {
          this.update();
        }
      })
      .catch(reason => {
        console.error("Unable to initialize viewer", reason);

        this._pagesCapability.reject(reason);
      });
  }

  /**
   * @param {Array|null} labels
   */
  setPageLabels(labels) {
    if (!this.pdfDocument) {
      return;
    }
    if (!labels) {
      this._pageLabels = null;
    } else if (
      !(Array.isArray(labels) && this.pdfDocument.numPages === labels.length)
    ) {
      this._pageLabels = null;
      console.error(`setPageLabels: Invalid page labels.`);
    } else {
      this._pageLabels = labels;
    }
    // Update all the `PDFPageView` instances.
    for (let i = 0, ii = this._pages.length; i < ii; i++) {
      this._pages[i].setPageLabel(this._pageLabels?.[i] ?? null);
    }
  }

  _resetView() {
    this._pages = [];
    this._currentPageNumber = 1;
    this._currentScale = UNKNOWN_SCALE;
    this._currentScaleValue = null;
    this._pageLabels = null;
    this.#buffer = new PDFPageViewBuffer(DEFAULT_CACHE_SIZE);
    this._location = null;
    this._pagesRotation = 0;
    this._optionalContentConfigPromise = null;
    this._firstPageCapability = createPromiseCapability();
    this._onePageRenderedCapability = createPromiseCapability();
    this._pagesCapability = createPromiseCapability();
    this._scrollMode = ScrollMode.VERTICAL;
    this._previousScrollMode = ScrollMode.UNKNOWN;
    this._spreadMode = SpreadMode.NONE;

    this.#scrollModePageState = {
      previousPageNumber: 1,
      scrollDown: true,
      pages: [],
    };

    if (this._onBeforeDraw) {
      this.eventBus._off("pagerender", this._onBeforeDraw);
      this._onBeforeDraw = null;
    }
    if (this._onAfterDraw) {
      this.eventBus._off("pagerendered", this._onAfterDraw);
      this._onAfterDraw = null;
    }
    if (this.#onVisibilityChange) {
      document.removeEventListener(
        "visibilitychange",
        this.#onVisibilityChange
      );
      this.#onVisibilityChange = null;
    }
    // Remove the pages from the DOM...
    this.viewer.textContent = "";
    // ... and reset the Scroll mode CSS class(es) afterwards.
    this._updateScrollMode();

    this.viewer.removeAttribute("lang");
    // Reset all PDF document permissions.
    this.viewer.classList.remove(ENABLE_PERMISSIONS_CLASS);
  }

  #ensurePageViewVisible() {
    if (this._scrollMode !== ScrollMode.PAGE) {
      throw new Error("#ensurePageViewVisible: Invalid scrollMode value.");
    }
    const pageNumber = this._currentPageNumber,
      state = this.#scrollModePageState,
      viewer = this.viewer;

    // Temporarily remove all the pages from the DOM...
    viewer.textContent = "";
    // ... and clear out the active ones.
    state.pages.length = 0;

    if (this._spreadMode === SpreadMode.NONE && !this.isInPresentationMode) {
      // Finally, append the new page to the viewer.
      const pageView = this._pages[pageNumber - 1];
      viewer.append(pageView.div);

      state.pages.push(pageView);
    } else {
      const pageIndexSet = new Set(),
        parity = this._spreadMode - 1;

      // Determine the pageIndices in the new spread.
      if (parity === -1) {
        // PresentationMode is active, with `SpreadMode.NONE` set.
        pageIndexSet.add(pageNumber - 1);
      } else if (pageNumber % 2 !== parity) {
        // Left-hand side page.
        pageIndexSet.add(pageNumber - 1);
        pageIndexSet.add(pageNumber);
      } else {
        // Right-hand side page.
        pageIndexSet.add(pageNumber - 2);
        pageIndexSet.add(pageNumber - 1);
      }

      // Finally, append the new pages to the viewer and apply the spreadMode.
      const spread = document.createElement("div");
      spread.className = "spread";

      if (this.isInPresentationMode) {
        const dummyPage = document.createElement("div");
        dummyPage.className = "dummyPage";
        spread.append(dummyPage);
      }

      for (const i of pageIndexSet) {
        const pageView = this._pages[i];
        if (!pageView) {
          continue;
        }
        spread.append(pageView.div);

        state.pages.push(pageView);
      }
      viewer.append(spread);
    }

    state.scrollDown = pageNumber >= state.previousPageNumber;
    state.previousPageNumber = pageNumber;
  }

  _scrollUpdate() {
    if (this.pagesCount === 0) {
      return;
    }
    this.update();
  }

  #scrollIntoView(pageView, pageSpot = null) {
    const { div, id } = pageView;

    // Ensure that `this._currentPageNumber` is correct, when `#scrollIntoView`
    // is called directly (and not from `#resetCurrentPageView`).
    if (this._currentPageNumber !== id) {
      this._setCurrentPageNumber(id);
    }
    if (this._scrollMode === ScrollMode.PAGE) {
      this.#ensurePageViewVisible();
      // Ensure that rendering always occurs, to avoid showing a blank page,
      // even if the current position doesn't change when the page is scrolled.
      this.update();
    }

    if (!pageSpot && !this.isInPresentationMode) {
      const left = div.offsetLeft + div.clientLeft,
        right = left + div.clientWidth;
      const { scrollLeft, clientWidth } = this.container;
      if (
        this._scrollMode === ScrollMode.HORIZONTAL ||
        left < scrollLeft ||
        right > scrollLeft + clientWidth
      ) {
        pageSpot = { left: 0, top: 0 };
      }
    }
    scrollIntoView(div, pageSpot);

    // Ensure that the correct *initial* document position is set, when any
    // OpenParameters are used, for documents with non-default Scroll/Spread
    // modes (fixes issue 15695). This is necessary since the scroll-handler
    // invokes the `update`-method asynchronously, and `this._location` could
    // thus be wrong when the initial zooming occurs in the default viewer.
    if (!this._currentScaleValue && this._location) {
      this._location = null;
    }
  }

  /**
   * Prevent unnecessary re-rendering of all pages when the scale changes
   * only because of limited numerical precision.
   */
  #isSameScale(newScale) {
    return (
      newScale === this._currentScale ||
      Math.abs(newScale - this._currentScale) < 1e-15
    );
  }

  _setScaleUpdatePages(newScale, newValue, noScroll = false, preset = false) {
    this._currentScaleValue = newValue.toString();

    if (this.#isSameScale(newScale)) {
      if (preset) {
        this.eventBus.dispatch("scalechanging", {
          source: this,
          scale: newScale,
          presetValue: newValue,
        });
      }
      return;
    }

    docStyle.setProperty(
      "--scale-factor",
      newScale * PixelsPerInch.PDF_TO_CSS_UNITS
    );

    const updateArgs = { scale: newScale };
    for (const pageView of this._pages) {
      pageView.update(updateArgs);
    }
    this._currentScale = newScale;

    if (!noScroll) {
      let page = this._currentPageNumber,
        dest;
      if (
        this._location &&
        !(this.isInPresentationMode || this.isChangingPresentationMode)
      ) {
        page = this._location.pageNumber;
        dest = [
          null,
          { name: "XYZ" },
          this._location.left,
          this._location.top,
          null,
        ];
      }
      this.scrollPageIntoView({
        pageNumber: page,
        destArray: dest,
        allowNegativeOffset: true,
      });
    }

    this.eventBus.dispatch("scalechanging", {
      source: this,
      scale: newScale,
      presetValue: preset ? newValue : undefined,
    });

    if (this.defaultRenderingQueue) {
      this.update();
    }
    this.updateContainerHeightCss();
  }

  /**
   * @private
   */
  get _pageWidthScaleFactor() {
    if (
      this._spreadMode !== SpreadMode.NONE &&
      this._scrollMode !== ScrollMode.HORIZONTAL
    ) {
      return 2;
    }
    return 1;
  }

  _setScale(value, noScroll = false) {
    let scale = parseFloat(value);

    if (scale > 0) {
      this._setScaleUpdatePages(scale, value, noScroll, /* preset = */ false);
    } else {
      const currentPage = this._pages[this._currentPageNumber - 1];
      if (!currentPage) {
        return;
      }
      let hPadding = SCROLLBAR_PADDING,
        vPadding = VERTICAL_PADDING;

      if (this.isInPresentationMode) {
        // Pages have a 2px (transparent) border in PresentationMode, see
        // the `web/pdf_viewer.css` file.
        hPadding = vPadding = 4; // 2 * 2px
        if (this._spreadMode !== SpreadMode.NONE) {
          // Account for two pages being visible in PresentationMode, thus
          // "doubling" the total border width.
          hPadding *= 2;
        }
      } else if (this.removePageBorders) {
        hPadding = vPadding = 0;
      } else if (this._scrollMode === ScrollMode.HORIZONTAL) {
        [hPadding, vPadding] = [vPadding, hPadding]; // Swap the padding values.
      }
      const pageWidthScale =
        (((this.container.clientWidth - hPadding) / currentPage.width) *
          currentPage.scale) /
        this._pageWidthScaleFactor;
      const pageHeightScale =
        ((this.container.clientHeight - vPadding) / currentPage.height) *
        currentPage.scale;
      switch (value) {
        case "page-actual":
          scale = 1;
          break;
        case "page-width":
          scale = pageWidthScale;
          break;
        case "page-height":
          scale = pageHeightScale;
          break;
        case "page-fit":
          scale = Math.min(pageWidthScale, pageHeightScale);
          break;
        case "auto":
          // For pages in landscape mode, fit the page height to the viewer
          // *unless* the page would thus become too wide to fit horizontally.
          const horizontalScale = isPortraitOrientation(currentPage)
            ? pageWidthScale
            : Math.min(pageHeightScale, pageWidthScale);
          scale = Math.min(MAX_AUTO_SCALE, horizontalScale);
          break;
        default:
          console.error(`_setScale: "${value}" is an unknown zoom value.`);
          return;
      }
      this._setScaleUpdatePages(scale, value, noScroll, /* preset = */ true);
    }
  }

  /**
   * Refreshes page view: scrolls to the current page and updates the scale.
   */
  #resetCurrentPageView() {
    const pageView = this._pages[this._currentPageNumber - 1];

    if (this.isInPresentationMode) {
      // Fixes the case when PDF has different page sizes.
      this._setScale(this._currentScaleValue, true);
    }
    this.#scrollIntoView(pageView);
  }

  /**
   * @param {string} label - The page label.
   * @returns {number|null} The page number corresponding to the page label,
   *   or `null` when no page labels exist and/or the input is invalid.
   */
  pageLabelToPageNumber(label) {
    if (!this._pageLabels) {
      return null;
    }
    const i = this._pageLabels.indexOf(label);
    if (i < 0) {
      return null;
    }
    return i + 1;
  }

  /**
   * @typedef {Object} ScrollPageIntoViewParameters
   * @property {number} pageNumber - The page number.
   * @property {Array} [destArray] - The original PDF destination array, in the
   *   format: <page-ref> </XYZ|/FitXXX> <args..>
   * @property {boolean} [allowNegativeOffset] - Allow negative page offsets.
   *   The default value is `false`.
   * @property {boolean} [ignoreDestinationZoom] - Ignore the zoom argument in
   *   the destination array. The default value is `false`.
   */

  /**
   * Scrolls page into view.
   * @param {ScrollPageIntoViewParameters} params
   */
  scrollPageIntoView({
    pageNumber,
    destArray = null,
    allowNegativeOffset = false,
    ignoreDestinationZoom = false,
  }) {
    if (!this.pdfDocument) {
      return;
    }
    const pageView =
      Number.isInteger(pageNumber) && this._pages[pageNumber - 1];
    if (!pageView) {
      console.error(
        `scrollPageIntoView: "${pageNumber}" is not a valid pageNumber parameter.`
      );
      return;
    }

    if (this.isInPresentationMode || !destArray) {
      this._setCurrentPageNumber(pageNumber, /* resetCurrentPageView = */ true);
      return;
    }
    let x = 0,
      y = 0;
    let width = 0,
      height = 0,
      widthScale,
      heightScale;
    const changeOrientation = pageView.rotation % 180 !== 0;
    const pageWidth =
      (changeOrientation ? pageView.height : pageView.width) /
      pageView.scale /
      PixelsPerInch.PDF_TO_CSS_UNITS;
    const pageHeight =
      (changeOrientation ? pageView.width : pageView.height) /
      pageView.scale /
      PixelsPerInch.PDF_TO_CSS_UNITS;
    let scale = 0;
    switch (destArray[1].name) {
      case "XYZ":
        x = destArray[2];
        y = destArray[3];
        scale = destArray[4];
        // If x and/or y coordinates are not supplied, default to
        // _top_ left of the page (not the obvious bottom left,
        // since aligning the bottom of the intended page with the
        // top of the window is rarely helpful).
        x = x !== null ? x : 0;
        y = y !== null ? y : pageHeight;
        break;
      case "Fit":
      case "FitB":
        scale = "page-fit";
        break;
      case "FitH":
      case "FitBH":
        y = destArray[2];
        scale = "page-width";
        // According to the PDF spec, section 12.3.2.2, a `null` value in the
        // parameter should maintain the position relative to the new page.
        if (y === null && this._location) {
          x = this._location.left;
          y = this._location.top;
        } else if (typeof y !== "number" || y < 0) {
          // The "top" value isn't optional, according to the spec, however some
          // bad PDF generators will pretend that it is (fixes bug 1663390).
          y = pageHeight;
        }
        break;
      case "FitV":
      case "FitBV":
        x = destArray[2];
        width = pageWidth;
        height = pageHeight;
        scale = "page-height";
        break;
      case "FitR":
        x = destArray[2];
        y = destArray[3];
        width = destArray[4] - x;
        height = destArray[5] - y;
        const hPadding = this.removePageBorders ? 0 : SCROLLBAR_PADDING;
        const vPadding = this.removePageBorders ? 0 : VERTICAL_PADDING;

        widthScale =
          (this.container.clientWidth - hPadding) /
          width /
          PixelsPerInch.PDF_TO_CSS_UNITS;
        heightScale =
          (this.container.clientHeight - vPadding) /
          height /
          PixelsPerInch.PDF_TO_CSS_UNITS;
        scale = Math.min(Math.abs(widthScale), Math.abs(heightScale));
        break;
      default:
        console.error(
          `scrollPageIntoView: "${destArray[1].name}" is not a valid destination type.`
        );
        return;
    }

    if (!ignoreDestinationZoom) {
      if (scale && scale !== this._currentScale) {
        this.currentScaleValue = scale;
      } else if (this._currentScale === UNKNOWN_SCALE) {
        this.currentScaleValue = DEFAULT_SCALE_VALUE;
      }
    }

    if (scale === "page-fit" && !destArray[4]) {
      this.#scrollIntoView(pageView);
      return;
    }

    const boundingRect = [
      pageView.viewport.convertToViewportPoint(x, y),
      pageView.viewport.convertToViewportPoint(x + width, y + height),
    ];
    let left = Math.min(boundingRect[0][0], boundingRect[1][0]);
    let top = Math.min(boundingRect[0][1], boundingRect[1][1]);

    if (!allowNegativeOffset) {
      // Some bad PDF generators will create destinations with e.g. top values
      // that exceeds the page height. Ensure that offsets are not negative,
      // to prevent a previous page from becoming visible (fixes bug 874482).
      left = Math.max(left, 0);
      top = Math.max(top, 0);
    }
    this.#scrollIntoView(pageView, /* pageSpot = */ { left, top });
  }

  _updateLocation(firstPage) {
    const currentScale = this._currentScale;
    const currentScaleValue = this._currentScaleValue;
    const normalizedScaleValue =
      parseFloat(currentScaleValue) === currentScale
        ? Math.round(currentScale * 10000) / 100
        : currentScaleValue;

    const pageNumber = firstPage.id;
    const currentPageView = this._pages[pageNumber - 1];
    const container = this.container;
    const topLeft = currentPageView.getPagePoint(
      container.scrollLeft - firstPage.x,
      container.scrollTop - firstPage.y
    );
    const intLeft = Math.round(topLeft[0]);
    const intTop = Math.round(topLeft[1]);

    let pdfOpenParams = `#page=${pageNumber}`;
    if (!this.isInPresentationMode) {
      pdfOpenParams += `&zoom=${normalizedScaleValue},${intLeft},${intTop}`;
    }

    this._location = {
      pageNumber,
      scale: normalizedScaleValue,
      top: intTop,
      left: intLeft,
      rotation: this._pagesRotation,
      pdfOpenParams,
    };
  }

  update() {
    const visible = this._getVisiblePages();
    const visiblePages = visible.views,
      numVisiblePages = visiblePages.length;

    if (numVisiblePages === 0) {
      return;
    }
    const newCacheSize = Math.max(DEFAULT_CACHE_SIZE, 2 * numVisiblePages + 1);
    this.#buffer.resize(newCacheSize, visible.ids);

    this.renderingQueue.renderHighestPriority(visible);

    const isSimpleLayout =
      this._spreadMode === SpreadMode.NONE &&
      (this._scrollMode === ScrollMode.PAGE ||
        this._scrollMode === ScrollMode.VERTICAL);
    const currentId = this._currentPageNumber;
    let stillFullyVisible = false;

    for (const page of visiblePages) {
      if (page.percent < 100) {
        break;
      }
      if (page.id === currentId && isSimpleLayout) {
        stillFullyVisible = true;
        break;
      }
    }
    this._setCurrentPageNumber(
      stillFullyVisible ? currentId : visiblePages[0].id
    );

    this._updateLocation(visible.first);
    this.eventBus.dispatch("updateviewarea", {
      source: this,
      location: this._location,
    });
  }

  containsElement(element) {
    return this.container.contains(element);
  }

  focus() {
    this.container.focus();
  }

  get _isContainerRtl() {
    return getComputedStyle(this.container).direction === "rtl";
  }

  get isInPresentationMode() {
    return this.presentationModeState === PresentationModeState.FULLSCREEN;
  }

  get isChangingPresentationMode() {
    return this.presentationModeState === PresentationModeState.CHANGING;
  }

  get isHorizontalScrollbarEnabled() {
    return this.isInPresentationMode
      ? false
      : this.container.scrollWidth > this.container.clientWidth;
  }

  get isVerticalScrollbarEnabled() {
    return this.isInPresentationMode
      ? false
      : this.container.scrollHeight > this.container.clientHeight;
  }

  _getVisiblePages() {
    const views =
        this._scrollMode === ScrollMode.PAGE
          ? this.#scrollModePageState.pages
          : this._pages,
      horizontal = this._scrollMode === ScrollMode.HORIZONTAL,
      rtl = horizontal && this._isContainerRtl;

    return getVisibleElements({
      scrollEl: this.container,
      views,
      sortByVisibility: true,
      horizontal,
      rtl,
    });
  }

  /**
   * @param {number} pageNumber
   */
  isPageVisible(pageNumber) {
    if (!this.pdfDocument) {
      return false;
    }
    if (
      !(
        Number.isInteger(pageNumber) &&
        pageNumber > 0 &&
        pageNumber <= this.pagesCount
      )
    ) {
      console.error(`isPageVisible: "${pageNumber}" is not a valid page.`);
      return false;
    }
    return this._getVisiblePages().ids.has(pageNumber);
  }

  /**
   * @param {number} pageNumber
   */
  isPageCached(pageNumber) {
    if (!this.pdfDocument) {
      return false;
    }
    if (
      !(
        Number.isInteger(pageNumber) &&
        pageNumber > 0 &&
        pageNumber <= this.pagesCount
      )
    ) {
      console.error(`isPageCached: "${pageNumber}" is not a valid page.`);
      return false;
    }
    const pageView = this._pages[pageNumber - 1];
    return this.#buffer.has(pageView);
  }

  cleanup() {
    for (const pageView of this._pages) {
      if (pageView.renderingState !== RenderingStates.FINISHED) {
        pageView.reset();
      }
    }
  }

  /**
   * @private
   */
  _cancelRendering() {
    for (const pageView of this._pages) {
      pageView.cancelRendering();
    }
  }

  /**
   * @param {PDFPageView} pageView
   * @returns {Promise<PDFPageProxy | null>}
   */
  async #ensurePdfPageLoaded(pageView) {
    if (pageView.pdfPage) {
      return pageView.pdfPage;
    }
    try {
      const pdfPage = await this.pdfDocument.getPage(pageView.id);
      if (!pageView.pdfPage) {
        pageView.setPdfPage(pdfPage);
      }
      if (!this.linkService._cachedPageNumber?.(pdfPage.ref)) {
        this.linkService.cachePageRef(pageView.id, pdfPage.ref);
      }
      return pdfPage;
    } catch (reason) {
      console.error("Unable to get page for page view", reason);
      return null; // Page error -- there is nothing that can be done.
    }
  }

  #getScrollAhead(visible) {
    if (visible.first?.id === 1) {
      return true;
    } else if (visible.last?.id === this.pagesCount) {
      return false;
    }
    switch (this._scrollMode) {
      case ScrollMode.PAGE:
        return this.#scrollModePageState.scrollDown;
      case ScrollMode.HORIZONTAL:
        return this.scroll.right;
    }
    return this.scroll.down;
  }

  /**
   * Only show the `loadingIcon`-spinner on visible pages (see issue 14242).
   */
  #toggleLoadingIconSpinner(visibleIds) {
    for (const id of visibleIds) {
      const pageView = this._pages[id - 1];
      pageView?.toggleLoadingIconSpinner(/* viewVisible = */ true);
    }
    for (const pageView of this.#buffer) {
      if (visibleIds.has(pageView.id)) {
        // Handled above, since the "buffer" may not contain all visible pages.
        continue;
      }
      pageView.toggleLoadingIconSpinner(/* viewVisible = */ false);
    }
  }

  forceRendering(currentlyVisiblePages) {
    const visiblePages = currentlyVisiblePages || this._getVisiblePages();
    const scrollAhead = this.#getScrollAhead(visiblePages);
    const preRenderExtra =
      this._spreadMode !== SpreadMode.NONE &&
      this._scrollMode !== ScrollMode.HORIZONTAL;

    const pageView = this.renderingQueue.getHighestPriority(
      visiblePages,
      this._pages,
      scrollAhead,
      preRenderExtra
    );
    this.#toggleLoadingIconSpinner(visiblePages.ids);

    if (pageView) {
      this.#ensurePdfPageLoaded(pageView).then(() => {
        this.renderingQueue.renderView(pageView);
      });
      return true;
    }
    return false;
  }

  /**
   * @typedef {Object} CreateTextLayerBuilderParameters
   * @property {TextHighlighter} highlighter
   * @property {TextAccessibilityManager} [accessibilityManager]
   * @property {boolean} [isOffscreenCanvasSupported]
   */

  /**
   * @param {CreateTextLayerBuilderParameters}
   * @returns {TextLayerBuilder}
   */
  createTextLayerBuilder({
    highlighter,
    accessibilityManager = null,
    isOffscreenCanvasSupported = true,
  }) {
    return new TextLayerBuilder({
      highlighter,
      accessibilityManager,
      isOffscreenCanvasSupported,
    });
  }

  /**
   * @typedef {Object} CreateTextHighlighterParameters
   * @property {number} pageIndex
   * @property {EventBus} eventBus
   */

  /**
   * @param {CreateTextHighlighterParameters}
   * @returns {TextHighlighter}
   */
  createTextHighlighter({ pageIndex, eventBus }) {
    return new TextHighlighter({
      eventBus,
      pageIndex,
      findController: this.findController,
    });
  }

  /**
   * @typedef {Object} CreateAnnotationLayerBuilderParameters
   * @property {HTMLDivElement} pageDiv
   * @property {PDFPageProxy} pdfPage
   * @property {AnnotationStorage} [annotationStorage] - Storage for annotation
   *   data in forms.
   * @property {string} [imageResourcesPath] - Path for image resources, mainly
   *   for annotation icons. Include trailing slash.
   * @property {boolean} renderForms
   * @property {IL10n} l10n
   * @property {boolean} [enableScripting]
   * @property {Promise<boolean>} [hasJSActionsPromise]
   * @property {Object} [mouseState]
   * @property {Promise<Object<string, Array<Object>> | null>}
   *   [fieldObjectsPromise]
   * @property {Map<string, HTMLCanvasElement>} [annotationCanvasMap] - Map some
   *   annotation ids with canvases used to render them.
   * @property {TextAccessibilityManager} [accessibilityManager]
   */

  /**
   * @param {CreateAnnotationLayerBuilderParameters}
   * @returns {AnnotationLayerBuilder}
   */
  createAnnotationLayerBuilder({
    pageDiv,
    pdfPage,
    annotationStorage = this.pdfDocument?.annotationStorage,
    imageResourcesPath = "",
    renderForms = true,
    l10n = NullL10n,
    enableScripting = this.enableScripting,
    hasJSActionsPromise = this.pdfDocument?.hasJSActions(),
    mouseState = this._scriptingManager?.mouseState,
    fieldObjectsPromise = this.pdfDocument?.getFieldObjects(),
    annotationCanvasMap = null,
    accessibilityManager = null,
  }) {
    return new AnnotationLayerBuilder({
      pageDiv,
      pdfPage,
      annotationStorage,
      imageResourcesPath,
      renderForms,
      linkService: this.linkService,
      downloadManager: this.downloadManager,
      l10n,
      enableScripting,
      hasJSActionsPromise,
      mouseState,
      fieldObjectsPromise,
      annotationCanvasMap,
      accessibilityManager,
    });
  }

  /**
   * @typedef {Object} CreateAnnotationEditorLayerBuilderParameters
   * @property {AnnotationEditorUIManager} [uiManager]
   * @property {HTMLDivElement} pageDiv
   * @property {PDFPageProxy} pdfPage
   * @property {IL10n} l10n
   * @property {TextAccessibilityManager} [accessibilityManager]
   */

  /**
   * @param {CreateAnnotationEditorLayerBuilderParameters}
   * @returns {AnnotationEditorLayerBuilder}
   */
  createAnnotationEditorLayerBuilder({
    uiManager = this.#annotationEditorUIManager,
    pageDiv,
    pdfPage,
    accessibilityManager = null,
    l10n,
  }) {
    return new AnnotationEditorLayerBuilder({
      uiManager,
      pageDiv,
      pdfPage,
      accessibilityManager,
      l10n,
    });
  }

  /**
   * @typedef {Object} CreateXfaLayerBuilderParameters
   * @property {HTMLDivElement} pageDiv
   * @property {PDFPageProxy} pdfPage
   * @property {AnnotationStorage} [annotationStorage] - Storage for annotation
   *   data in forms.
   */

  /**
   * @param {CreateXfaLayerBuilderParameters}
   * @returns {XfaLayerBuilder}
   */
  createXfaLayerBuilder({
    pageDiv,
    pdfPage,
    annotationStorage = this.pdfDocument?.annotationStorage,
  }) {
    return new XfaLayerBuilder({
      pageDiv,
      pdfPage,
      annotationStorage,
      linkService: this.linkService,
    });
  }

  /**
   * @returns {StructTreeLayerBuilder}
   */
  createStructTreeLayerBuilder() {
    return new StructTreeLayerBuilder();
  }

  /**
   * @type {boolean} Whether all pages of the PDF document have identical
   *   widths and heights.
   */
  get hasEqualPageSizes() {
    const firstPageView = this._pages[0];
    for (let i = 1, ii = this._pages.length; i < ii; ++i) {
      const pageView = this._pages[i];
      if (
        pageView.width !== firstPageView.width ||
        pageView.height !== firstPageView.height
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Returns sizes of the pages.
   * @returns {Array} Array of objects with width/height/rotation fields.
   */
  getPagesOverview() {
    return this._pages.map(pageView => {
      const viewport = pageView.pdfPage.getViewport({ scale: 1 });

      if (!this.enablePrintAutoRotate || isPortraitOrientation(viewport)) {
        return {
          width: viewport.width,
          height: viewport.height,
          rotation: viewport.rotation,
        };
      }
      // Landscape orientation.
      return {
        width: viewport.height,
        height: viewport.width,
        rotation: (viewport.rotation - 90) % 360,
      };
    });
  }

  /**
   * @type {Promise<OptionalContentConfig | null>}
   */
  get optionalContentConfigPromise() {
    if (!this.pdfDocument) {
      return Promise.resolve(null);
    }
    if (!this._optionalContentConfigPromise) {
      console.error("optionalContentConfigPromise: Not initialized yet.");
      // Prevent issues if the getter is accessed *before* the `onePageRendered`
      // promise has resolved; won't (normally) happen in the default viewer.
      return this.pdfDocument.getOptionalContentConfig();
    }
    return this._optionalContentConfigPromise;
  }

  /**
   * @param {Promise<OptionalContentConfig>} promise - A promise that is
   *   resolved with an {@link OptionalContentConfig} instance.
   */
  set optionalContentConfigPromise(promise) {
    if (!(promise instanceof Promise)) {
      throw new Error(`Invalid optionalContentConfigPromise: ${promise}`);
    }
    if (!this.pdfDocument) {
      return;
    }
    if (!this._optionalContentConfigPromise) {
      // Ignore the setter *before* the `onePageRendered` promise has resolved,
      // since it'll be overwritten anyway; won't happen in the default viewer.
      return;
    }
    this._optionalContentConfigPromise = promise;

    const updateArgs = { optionalContentConfigPromise: promise };
    for (const pageView of this._pages) {
      pageView.update(updateArgs);
    }
    this.update();

    this.eventBus.dispatch("optionalcontentconfigchanged", {
      source: this,
      promise,
    });
  }

  /**
   * @type {number} One of the values in {ScrollMode}.
   */
  get scrollMode() {
    return this._scrollMode;
  }

  /**
   * @param {number} mode - The direction in which the document pages should be
   *   laid out within the scrolling container.
   *   The constants from {ScrollMode} should be used.
   */
  set scrollMode(mode) {
    if (this._scrollMode === mode) {
      return; // The Scroll mode didn't change.
    }
    if (!isValidScrollMode(mode)) {
      throw new Error(`Invalid scroll mode: ${mode}`);
    }
    if (this.pagesCount > PagesCountLimit.FORCE_SCROLL_MODE_PAGE) {
      return; // Disabled for performance reasons.
    }
    this._previousScrollMode = this._scrollMode;

    this._scrollMode = mode;
    this.eventBus.dispatch("scrollmodechanged", { source: this, mode });

    this._updateScrollMode(/* pageNumber = */ this._currentPageNumber);
  }

  _updateScrollMode(pageNumber = null) {
    const scrollMode = this._scrollMode,
      viewer = this.viewer;

    viewer.classList.toggle(
      "scrollHorizontal",
      scrollMode === ScrollMode.HORIZONTAL
    );
    viewer.classList.toggle("scrollWrapped", scrollMode === ScrollMode.WRAPPED);

    if (!this.pdfDocument || !pageNumber) {
      return;
    }

    if (scrollMode === ScrollMode.PAGE) {
      this.#ensurePageViewVisible();
    } else if (this._previousScrollMode === ScrollMode.PAGE) {
      // Ensure that the current spreadMode is still applied correctly when
      // the *previous* scrollMode was `ScrollMode.PAGE`.
      this._updateSpreadMode();
    }
    // Non-numeric scale values can be sensitive to the scroll orientation.
    // Call this before re-scrolling to the current page, to ensure that any
    // changes in scale don't move the current page.
    if (this._currentScaleValue && isNaN(this._currentScaleValue)) {
      this._setScale(this._currentScaleValue, true);
    }
    this._setCurrentPageNumber(pageNumber, /* resetCurrentPageView = */ true);
    this.update();
  }

  /**
   * @type {number} One of the values in {SpreadMode}.
   */
  get spreadMode() {
    return this._spreadMode;
  }

  /**
   * @param {number} mode - Group the pages in spreads, starting with odd- or
   *   even-number pages (unless `SpreadMode.NONE` is used).
   *   The constants from {SpreadMode} should be used.
   */
  set spreadMode(mode) {
    if (this._spreadMode === mode) {
      return; // The Spread mode didn't change.
    }
    if (!isValidSpreadMode(mode)) {
      throw new Error(`Invalid spread mode: ${mode}`);
    }
    this._spreadMode = mode;
    this.eventBus.dispatch("spreadmodechanged", { source: this, mode });

    this._updateSpreadMode(/* pageNumber = */ this._currentPageNumber);
  }

  _updateSpreadMode(pageNumber = null) {
    if (!this.pdfDocument) {
      return;
    }
    const viewer = this.viewer,
      pages = this._pages;

    if (this._scrollMode === ScrollMode.PAGE) {
      this.#ensurePageViewVisible();
    } else {
      // Temporarily remove all the pages from the DOM.
      viewer.textContent = "";

      if (this._spreadMode === SpreadMode.NONE) {
        for (const pageView of this._pages) {
          viewer.append(pageView.div);
        }
      } else {
        const parity = this._spreadMode - 1;
        let spread = null;
        for (let i = 0, ii = pages.length; i < ii; ++i) {
          if (spread === null) {
            spread = document.createElement("div");
            spread.className = "spread";
            viewer.append(spread);
          } else if (i % 2 === parity) {
            spread = spread.cloneNode(false);
            viewer.append(spread);
          }
          spread.append(pages[i].div);
        }
      }
    }

    if (!pageNumber) {
      return;
    }
    // Non-numeric scale values can be sensitive to the scroll orientation.
    // Call this before re-scrolling to the current page, to ensure that any
    // changes in scale don't move the current page.
    if (this._currentScaleValue && isNaN(this._currentScaleValue)) {
      this._setScale(this._currentScaleValue, true);
    }
    this._setCurrentPageNumber(pageNumber, /* resetCurrentPageView = */ true);
    this.update();
  }

  /**
   * @private
   */
  _getPageAdvance(currentPageNumber, previous = false) {
    switch (this._scrollMode) {
      case ScrollMode.WRAPPED: {
        const { views } = this._getVisiblePages(),
          pageLayout = new Map();

        // Determine the current (visible) page layout.
        for (const { id, y, percent, widthPercent } of views) {
          if (percent === 0 || widthPercent < 100) {
            continue;
          }
          let yArray = pageLayout.get(y);
          if (!yArray) {
            pageLayout.set(y, (yArray ||= []));
          }
          yArray.push(id);
        }
        // Find the row of the current page.
        for (const yArray of pageLayout.values()) {
          const currentIndex = yArray.indexOf(currentPageNumber);
          if (currentIndex === -1) {
            continue;
          }
          const numPages = yArray.length;
          if (numPages === 1) {
            break;
          }
          // Handle documents with varying page sizes.
          if (previous) {
            for (let i = currentIndex - 1, ii = 0; i >= ii; i--) {
              const currentId = yArray[i],
                expectedId = yArray[i + 1] - 1;
              if (currentId < expectedId) {
                return currentPageNumber - expectedId;
              }
            }
          } else {
            for (let i = currentIndex + 1, ii = numPages; i < ii; i++) {
              const currentId = yArray[i],
                expectedId = yArray[i - 1] + 1;
              if (currentId > expectedId) {
                return expectedId - currentPageNumber;
              }
            }
          }
          // The current row is "complete", advance to the previous/next one.
          if (previous) {
            const firstId = yArray[0];
            if (firstId < currentPageNumber) {
              return currentPageNumber - firstId + 1;
            }
          } else {
            const lastId = yArray[numPages - 1];
            if (lastId > currentPageNumber) {
              return lastId - currentPageNumber + 1;
            }
          }
          break;
        }
        break;
      }
      case ScrollMode.HORIZONTAL: {
        break;
      }
      case ScrollMode.PAGE:
      case ScrollMode.VERTICAL: {
        if (this._spreadMode === SpreadMode.NONE) {
          break; // Normal vertical scrolling.
        }
        const parity = this._spreadMode - 1;

        if (previous && currentPageNumber % 2 !== parity) {
          break; // Left-hand side page.
        } else if (!previous && currentPageNumber % 2 === parity) {
          break; // Right-hand side page.
        }
        const { views } = this._getVisiblePages(),
          expectedId = previous ? currentPageNumber - 1 : currentPageNumber + 1;

        for (const { id, percent, widthPercent } of views) {
          if (id !== expectedId) {
            continue;
          }
          if (percent > 0 && widthPercent === 100) {
            return 2;
          }
          break;
        }
        break;
      }
    }
    return 1;
  }

  /**
   * Go to the next page, taking scroll/spread-modes into account.
   * @returns {boolean} Whether navigation occured.
   */
  nextPage() {
    const currentPageNumber = this._currentPageNumber,
      pagesCount = this.pagesCount;

    if (currentPageNumber >= pagesCount) {
      return false;
    }
    const advance =
      this._getPageAdvance(currentPageNumber, /* previous = */ false) || 1;

    this.currentPageNumber = Math.min(currentPageNumber + advance, pagesCount);
    return true;
  }

  /**
   * Go to the previous page, taking scroll/spread-modes into account.
   * @returns {boolean} Whether navigation occured.
   */
  previousPage() {
    const currentPageNumber = this._currentPageNumber;

    if (currentPageNumber <= 1) {
      return false;
    }
    const advance =
      this._getPageAdvance(currentPageNumber, /* previous = */ true) || 1;

    this.currentPageNumber = Math.max(currentPageNumber - advance, 1);
    return true;
  }

  /**
   * Increase the current zoom level one, or more, times.
   * @param {number} [steps] - Defaults to zooming once.
   */
  increaseScale(steps = 1) {
    let newScale = this._currentScale;
    do {
      newScale = (newScale * DEFAULT_SCALE_DELTA).toFixed(2);
      newScale = Math.ceil(newScale * 10) / 10;
      newScale = Math.min(MAX_SCALE, newScale);
    } while (--steps > 0 && newScale < MAX_SCALE);
    this.currentScaleValue = newScale;
  }

  /**
   * Decrease the current zoom level one, or more, times.
   * @param {number} [steps] - Defaults to zooming once.
   */
  decreaseScale(steps = 1) {
    let newScale = this._currentScale;
    do {
      newScale = (newScale / DEFAULT_SCALE_DELTA).toFixed(2);
      newScale = Math.floor(newScale * 10) / 10;
      newScale = Math.max(MIN_SCALE, newScale);
    } while (--steps > 0 && newScale > MIN_SCALE);
    this.currentScaleValue = newScale;
  }

  updateContainerHeightCss() {
    const height = this.container.clientHeight;

    if (height !== this.#previousContainerHeight) {
      this.#previousContainerHeight = height;

      docStyle.setProperty("--viewer-container-height", `${height}px`);
    }
  }

  /**
   * @type {number}
   */
  get annotationEditorMode() {
    return this.#annotationEditorUIManager
      ? this.#annotationEditorMode
      : AnnotationEditorType.DISABLE;
  }

  /**
   * @param {number} mode - AnnotationEditor mode (None, FreeText, Ink, ...)
   */
  set annotationEditorMode(mode) {
    if (!this.#annotationEditorUIManager) {
      throw new Error(`The AnnotationEditor is not enabled.`);
    }
    if (this.#annotationEditorMode === mode) {
      return; // The AnnotationEditor mode didn't change.
    }
    if (!isValidAnnotationEditorMode(mode)) {
      throw new Error(`Invalid AnnotationEditor mode: ${mode}`);
    }
    if (!this.pdfDocument) {
      return;
    }
    this.#annotationEditorMode = mode;
    this.eventBus.dispatch("annotationeditormodechanged", {
      source: this,
      mode,
    });

    this.#annotationEditorUIManager.updateMode(mode);
  }

  // eslint-disable-next-line accessor-pairs
  set annotationEditorParams({ type, value }) {
    if (!this.#annotationEditorUIManager) {
      throw new Error(`The AnnotationEditor is not enabled.`);
    }
    this.#annotationEditorUIManager.updateParams(type, value);
  }

  refresh() {
    if (!this.pdfDocument) {
      return;
    }
    const updateArgs = {};
    for (const pageView of this._pages) {
      pageView.update(updateArgs);
    }
    this.update();
  }
}

export { PagesCountLimit, PDFPageViewBuffer, PDFViewer };
