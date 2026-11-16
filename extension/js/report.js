// report.js - the extension's report page. The side panel turns it into a PDF
// with Chrome's own PDF engine (Bangla text stays sharp and selectable).
import { reportHtml } from "./report-html.js";

const { report } = await chrome.storage.local.get("report");
report.ai ||= "Chrome-এর built-in Gemini Nano, বাংলা অনুবাদ Chrome Translator";
document.getElementById("report").innerHTML = reportHtml(report);
document.title = report.paper.title + " · বাংলা বিশ্লেষণ";
document.getElementById("print").onclick = () => print();

await document.fonts.ready;
chrome.runtime.sendMessage({ type: "report-ready" }).catch(() => {});
