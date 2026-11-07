// Owns cross-feature shell layout: fullscreen focus and draggable panel sizes.
import { fitDagNetwork } from "./dag_network_controller.mjs";
export function createDagShellController({ state, elements, renderDag, getNetwork, isDagFullyVisible, dismissEvidencePane }) {
  let showInstalledMobilePanel = null;
  // Set by installResizers; moves the evidence pane to where the current task reads it.
  let placeEvidencePane = () => {};

  function showMobilePanel(panel) {
    if (!window.matchMedia?.("(max-width: 840px)").matches || !showInstalledMobilePanel) return false;
    showInstalledMobilePanel(panel);
    return true;
  }

  function installMobilePanelNavigation() {
    const tabs = [...document.querySelectorAll("[data-mobile-panel]")];
    if (!tabs.length) return;

    const showPanel = requestedPanel => {
      const panel = requestedPanel === "dag" && document.body.classList.contains("defining-variable")
        ? "controls" : requestedPanel;
      document.body.dataset.mobilePanel = panel;
      for (const tab of tabs) {
        const active = tab.dataset.mobilePanel === panel;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-pressed", active ? "true" : "false");
      }
      requestAnimationFrame(() => {
        if (panel === "dag") {
          renderDag();
          setTimeout(() => fitDagNetwork(getNetwork()), 50);
        }
      });
    };
    showInstalledMobilePanel = showPanel;

    document.body.dataset.mobilePanel ||= "controls";
    for (const tab of tabs) tab.addEventListener("click", () => {
      if (tab.dataset.mobilePanel === "dag" && !elements.closeEvidencePane.hidden) dismissEvidencePane();
      showPanel(tab.dataset.mobilePanel);
    });
    if (document.body.dataset.mobilePanel === "variables") document.body.dataset.mobilePanel = "controls";
    new MutationObserver(() => {
      if (document.body.dataset.mobilePanel === "dag" && document.body.classList.contains("defining-variable")) {
        showPanel("controls");
      } else if (document.body.dataset.mobilePanel !== "controls" && document.body.classList.contains("initial-setup")
        && !document.body.classList.contains("defining-variable")) {
        // Choosing the first variables has no tab bar and no graph: arriving from another view's Graph tab would otherwise leave a blank screen.
        showPanel("controls");
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    showPanel(document.body.dataset.mobilePanel);
  }

  function setFullscreen(requested) {
    // A phone hides the top bar in full screen, and with it the only way back; touch has no Escape key.
    const panel = globalThis.window?.matchMedia?.("(max-width: 840px)").matches ? null : requested;
    state.fullscreenPanel = panel;
    document.body.classList.toggle("focus-dag", panel === "dag");
    elements.fullscreenDag.classList.toggle("active", panel === "dag");
    elements.fullscreenDag.setAttribute("aria-pressed", panel === "dag" ? "true" : "false");
    // An icon button: swap its label, while CSS swaps the maximize/minimize icon on aria-pressed.
    const dagLabel = panel === "dag" ? "Exit full screen" : "Full screen graph";
    elements.fullscreenDag.setAttribute("aria-label", dagLabel);
    elements.fullscreenDag.title = panel === "dag" ? "Exit full screen (Escape)" : "Expand the graph to fill the window; press Escape to exit";
    requestAnimationFrame(() => {
      const network = getNetwork();
      if (network) network.setSize("100%", "100%");
      else renderDag();
      setTimeout(() => fitDagNetwork(getNetwork()), 100);
    });
  }

  function toggleFullscreen(panel) {
    setFullscreen(state.fullscreenPanel === panel ? null : panel);
  }

  function installResizers() {
    const shell = document.querySelector(".dag-shell");
    const workspace = elements.dagWorkspaceSection;
    const evidencePane = document.querySelector(".dag-ws-footer");
    const leftPanel = document.querySelector(".dag-left-panel");
    const mobileLayout = window.matchMedia("(max-width: 840px)");
    // On a phone, and in Explore on any screen, the evidence opens under the
    // graph so the results list stays in view. Identify still reads it in the
    // side panel.
    placeEvidencePane = () => {
      // In every task the evidence sits under the graph; the legacy layout keeps it in the side panel.
      const parent = mobileLayout.matches || state.task ? workspace : leftPanel;
      if (evidencePane && parent && evidencePane.parentElement !== parent) parent.append(evidencePane);
    };
    mobileLayout.addEventListener("change", placeEvidencePane);
    mobileLayout.addEventListener("change", () => { if (mobileLayout.matches && state.fullscreenPanel) setFullscreen(null); });
    placeEvidencePane();
    // Creating a variable: on a wide screen the creation steps take the map's
    // place; on a phone they stay in the side panel where they were written.
    const definitionBlock = elements.definitionBlock || document.getElementById("definitionBlock");
    const definitionWorkspace = document.getElementById("definitionWorkspace");
    const definitionHome = definitionBlock && document.createComment("definition block home");
    definitionBlock?.before(definitionHome);
    const placeDefinitionBlock = () => {
      if (!definitionBlock || !definitionWorkspace) return;
      const wide = !mobileLayout.matches;
      if (wide && definitionBlock.parentElement !== definitionWorkspace) definitionWorkspace.append(definitionBlock);
      else if (!wide && definitionBlock.previousSibling !== definitionHome) definitionHome.after(definitionBlock);
    };
    mobileLayout.addEventListener("change", placeDefinitionBlock);
    placeDefinitionBlock();
    let leftWidth = 370, rightWidth = 450;
    const applyWidths = () => {
      shell.style.gridTemplateColumns = state.interfaceMode === "dag2"
        ? `${leftWidth}px 5px minmax(0, 1fr)`
        : `${leftWidth}px 5px 1fr 5px ${rightWidth}px`;
    };
    window._dagPanelSetRight = width => { rightWidth = width; applyWidths(); };
    window._dagPanelGetRight = () => rightWidth;

    function makeResizer(element, side) {
      element.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        // Capture the pointer so a drag that leaves the divider (or the window) still ends cleanly.
        element.setPointerCapture?.(event.pointerId);
        const resizeDag = state.interfaceMode === "dag2" || side === "right";
        const refitDag = resizeDag && isDagFullyVisible();
        const startX = event.clientX;
        const startWidth = side === "left" ? leftWidth : rightWidth;
        let moved = false;
        element.classList.add("dragging");
        function onMove(moveEvent) {
          const sign = side === "left" ? 1 : -1;
          const width = Math.max(240, Math.min(950, startWidth + sign * (moveEvent.clientX - startX)));
          moved ||= width !== startWidth;
          if (side === "left") leftWidth = width; else rightWidth = width;
          applyWidths();
        }
        function onUp() {
          element.classList.remove("dragging");
          element.removeEventListener("pointermove", onMove);
          element.removeEventListener("pointerup", onUp);
          element.removeEventListener("pointercancel", onUp);
          element.removeEventListener("lostpointercapture", onUp);
          if (moved && refitDag) setTimeout(() => fitDagNetwork(getNetwork()), 50);
        }
        element.addEventListener("pointermove", onMove);
        element.addEventListener("pointerup", onUp);
        element.addEventListener("pointercancel", onUp);
        element.addEventListener("lostpointercapture", onUp);
      });
    }

    makeResizer(elements.leftResizer, "left");
    if (state.interfaceMode !== "dag2") makeResizer(elements.rightResizer, "right");
    applyWidths();
    installMobilePanelNavigation();
  }

  return { setFullscreen, toggleFullscreen, installResizers, showMobilePanel, placeEvidencePane: () => placeEvidencePane() };
}
