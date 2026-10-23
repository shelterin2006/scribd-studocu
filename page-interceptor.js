(function() {
  if (window.__scribdDownloaderInterceptorInstalled) {
    return;
  }

  window.__scribdDownloaderInterceptorInstalled = true;

  function reportUrl(url) {
    if (typeof url !== 'string') {
      return;
    }

    window.postMessage({
      source: 'scribd-downloader-page',
      type: 'pageRequestUrl',
      url: url
    }, '*');
  }

  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const request = args[0];
    const url = typeof request === 'string' ? request : request && request.url;
    reportUrl(url);
    return originalFetch.apply(this, args);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    reportUrl(url);
    return originalOpen.apply(this, arguments);
  };
})();
