"use strict";

// This is only intended to signal that the viewer is not ready for public consumption and is not a security measure.
const VIEWER_PASSWORD = "12345";
const SESSION_KEY = "echo-viewer-password-accepted";

const gate = document.getElementById("passwordGate");
const form = document.getElementById("passwordGateForm");
const input = document.getElementById("passwordGateInput");
const error = document.getElementById("passwordGateError");

function unlockViewer() {
  document.body.classList.remove("password-locked");
  gate.hidden = true;
}

if (sessionStorage.getItem(SESSION_KEY) === "yes") {
  unlockViewer();
} else {
  input.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();

  if (input.value === VIEWER_PASSWORD) {
    sessionStorage.setItem(SESSION_KEY, "yes");
    unlockViewer();
    return;
  }

  error.hidden = false;
  input.value = "";
  input.focus();
});

input.addEventListener("input", () => {
  error.hidden = true;
});
