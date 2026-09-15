// Owns cross-feature shell layout: fullscreen focus and draggable panel sizes.
export function createDagShellController({ state, elements, resizeMap, fitMap, renderDag, getNetwork }) {
  function installMobilePanelNavigation() {
    const tabs = [...document.querySelectorAll("[data-mobile-panel]")];
    if (!tabs.length) return;

    const showPanel = panel => {
      document.body.dataset.mobilePanel = panel;
      for (const tab of tabs) {
        const active = tab.dataset.mobilePanel === panel;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-pressed", active ? "true" : "false");
      }
      requestAnimationFrame(() => {
        if (panel === "variables") {
          resizeMap();
          fitMap();
        } else if (panel === "dag") {
          renderDag();
          setTimeout(() => getNetwork()?.fit({ animation: false, padding: 28 }), 50);
        }
      });
    };

    document.body.dataset.mobilePanel ||= "controls";
    for (const tab of tabs) tab.addEventListener("click", () => showPanel(tab.dataset.mobilePanel));
    if (document.body.dataset.mobilePanel === "variables" && !document.body.classList.contains("defining-variable")) {
      document.body.dataset.mobilePanel = "controls";
    }
    new MutationObserver(() => {
      if (document.body.dataset.mobilePanel === "variables" && !document.body.classList.contains("defining-variable")) {
        showPanel("controls");
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    showPanel(document.body.dataset.mobilePanel);
  }

  function setFullscreen(panel) {
    state.fullscreenPanel = panel;
    document.body.classList.toggle("focus-variable-map", panel === "variable-map");
    document.body.classList.toggle("focus-dag", panel === "dag");
    elements.fullscreenVariableMap.classList.toggle("active", panel === "variable-map");
    elements.fullscreenVariableMap.setAttribute("aria-pressed", panel === "variable-map" ? "true" : "false");
    elements.fullscreenVariableMap.textContent = panel === "variable-map" ? "Exit full screen" : "Full screen map";
    elements.fullscreenDag.classList.toggle("active", panel === "dag");
    elements.fullscreenDag.setAttribute("aria-pressed", panel === "dag" ? "true" : "false");
    elements.fullscreenDag.textContent = panel === "dag" ? "Exit full screen" : "Full screen DAG";
    requestAnimationFrame(() => {
      resizeMap();
      if (panel !== "dag") fitMap();
      renderDag();
      setTimeout(() => getNetwork()?.fit({ animation: false, padding: 28 }), 100);
    });
  }

  function toggleFullscreen(panel) {
    setFullscreen(state.fullscreenPanel === panel ? null : panel);
  }

  function installResizers() {
    const shell = document.querySelector(".dag-shell");
    const workspace = elements.dagWorkspaceSection;
    let leftWidth = 370, rightWidth = 450, footerHeight = 200;
    const applyWidths = () => {
      shell.style.gridTemplateColumns = state.interfaceMode === "dag2"
        ? `${leftWidth}px 5px minmax(0, 1fr)`
        : `${leftWidth}px 5px 1fr 5px ${rightWidth}px`;
    };
    const applyFooterHeight = height => {
      footerHeight = height;
      workspace?.style.setProperty("--dag-footer-height", `${footerHeight}px`);
    };
    window._dagPanelSetRight = width => { rightWidth = width; applyWidths(); resizeMap(); };
    window._dagPanelGetRight = () => rightWidth;

    function makeResizer(element, side) {
      element.addEventListener("mousedown", event => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = side === "left" ? leftWidth : rightWidth;
        element.classList.add("dragging");
        function onMove(moveEvent) {
          const sign = side === "left" ? 1 : -1;
          const width = Math.max(240, Math.min(950, startWidth + sign * (moveEvent.clientX - startX)));
          if (side === "left") leftWidth = width; else rightWidth = width;
          applyWidths();
        }
        function onUp() {
          element.classList.remove("dragging");
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          resizeMap();
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }

    makeResizer(elements.leftResizer, "left");
    if (state.interfaceMode !== "dag2") makeResizer(elements.rightResizer, "right");
    if (elements.dagWorkspaceResizer && workspace) {
      elements.dagWorkspaceResizer.addEventListener("mousedown", event => {
        event.preventDefault();
        const startY = event.clientY, startHeight = footerHeight;
        const workspaceHeight = workspace.getBoundingClientRect().height;
        elements.dagWorkspaceResizer.classList.add("dragging");
        function onMove(moveEvent) {
          applyFooterHeight(Math.max(120, Math.min(workspaceHeight * 0.6, startHeight - (moveEvent.clientY - startY))));
          getNetwork()?.redraw();
        }
        function onUp() {
          elements.dagWorkspaceResizer.classList.remove("dragging");
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          renderDag();
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }
    applyWidths();
    applyFooterHeight(footerHeight);
    installMobilePanelNavigation();
  }

  return { setFullscreen, toggleFullscreen, installResizers };
}
