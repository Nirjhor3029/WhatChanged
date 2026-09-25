(function () {
  try {
    var t = localStorage.getItem('dbc:theme');
    t = t ? JSON.parse(t) : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = t;
  } catch (e) { document.documentElement.dataset.theme = 'dark'; }
})();
