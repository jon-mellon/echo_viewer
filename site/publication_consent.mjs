export function confirmPublicPublication(dialog, windowApi) {
  if (!dialog?.showModal) {
    return Promise.resolve(windowApi.confirm(
      "Publish this schema publicly?\n\nPublishing creates an immutable public version that anyone with the link can view and download. Your unpublished local edits remain private until you publish them.\n\nBy choosing OK, you agree to dedicate the titles and descriptions you contribute under CC0 1.0 Universal without an attribution requirement. You confirm that you have the rights to do so and that your contributions contain no third-party copyrighted material or unsuitable content.",
    ));
  }

  const consent = dialog.querySelector("[data-publication-consent]");
  const publishButton = dialog.querySelector('button[value="publish"]');
  if (!consent || !publishButton) return Promise.resolve(false);

  consent.checked = false;
  publishButton.disabled = true;
  dialog.returnValue = "cancel";

  return new Promise(resolve => {
    const updateButton = () => { publishButton.disabled = !consent.checked; };
    const close = () => {
      consent.removeEventListener("change", updateButton);
      resolve(dialog.returnValue === "publish" && consent.checked);
    };
    consent.addEventListener("change", updateButton);
    dialog.addEventListener("close", close, { once: true });
    dialog.showModal();
  });
}
