import { getSettings, setSettings } from "../shared/settings.js";

const form = document.getElementById("form");
const saved = document.getElementById("saved");

async function init() {
  const s = await getSettings();
  form.dpi.value = String(s.dpi);
  form.autoScan.checked = s.autoScan;
  form.linkHidden.checked = s.linkHidden;
  for (const r of form.linkTarget) r.checked = r.value === s.linkTarget;

  form.addEventListener("change", async () => {
    await setSettings({
      dpi: Number(form.dpi.value),
      autoScan: form.autoScan.checked,
      linkTarget: form.linkTarget.value === "_self" ? "_self" : "_blank",
      linkHidden: form.linkHidden.checked,
    });
    saved.textContent = "Saved. Open viewers update immediately.";
  });
}

init();
