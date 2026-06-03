// Trivial renderer script. Runs in the isolated renderer context; talk to the
// main process only through the `appInfo` bridge exposed by preload.ts.
const heading = document.getElementById("app-heading");
if (heading) {
  heading.textContent = "Workboard";
}
