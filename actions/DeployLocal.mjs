import "./Build.mjs";

if (!process.exitCode) {
  console.log("Local build ready: api/function.zip (staged contents: api/dist).");
  console.log("ScreenGrabber has no local API runner or AWS emulator configured.");
  console.log("Deploy Local packages only; it does not start a server or update AWS.");
  console.log("See README.md for local limitations and production deployment.");
}
