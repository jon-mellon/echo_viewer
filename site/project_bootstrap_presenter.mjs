export function createProjectBootstrapPresenter({ windowApi = window, documentApi = document }) {
  function setStartupStage(message) {
    const stage = documentApi.getElementById("startupLoadingStage");
    if (stage) stage.textContent = message;
    windowApi.dispatchEvent(new CustomEvent("startupstage", { detail: message }));
  }

  function finishStartupLoading() {
    documentApi.getElementById("startupLoading")?.setAttribute("hidden", "");
    documentApi.body.classList.remove("viewer-loading");
  }

  function configureInterface(interfaceMode) {
    documentApi.body.classList.toggle("dag2-mode", interfaceMode === "dag2");
    if (interfaceMode !== "dag2") return;
    documentApi.title = "ECHO";
    documentApi.querySelector(".panel-header h1").textContent = "ECHO";
    documentApi.querySelector(".dag-left-panel")?.append(documentApi.getElementById("exportSection"));
  }

  const confirmResumeDefinition = () => windowApi.confirm(
    "Resume the unfinished variable definition? Press Cancel to discard it.",
  );

  return { setStartupStage, finishStartupLoading, configureInterface, confirmResumeDefinition };
}
