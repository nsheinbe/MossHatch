/* Queues beforeSend for /_vercel/insights/script.js (loaded next, from Vercel).
   Query and hash are removed so invite tokens, device codes and checkout ids in the URL are not sent. */
(function () {
  window.vaq = window.vaq || [];
  window.va = window.va || function () { window.vaq.push(Array.prototype.slice.call(arguments)); };
  window.va("beforeSend", function (event) {
    if (!event || typeof event.url !== "string") return event;
    try {
      var url = new URL(event.url, location.href);
      url.search = "";
      url.hash = "";
      event.url = url.href;
    } catch (e) {
      return null;
    }
    return event;
  });
})();
