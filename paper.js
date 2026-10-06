// Sets the chosen paper (View → Paper) on <html> before the page first paints, so a reader who keeps the Night paper never sees a flash of
// newsprint on the way in. A separate file because the Content-Security-Policy forbids inline scripts; loaded in <head> without defer.
// app.js owns the menu and calls setPaper when the choice changes.
try {
  var p = localStorage.getItem("rolodex.paper") || "white";
  if (p === "dusk") p = "white";   // Dusk was replaced by Night; a reader who had it goes back to Newsprint
  document.documentElement.dataset.paper = p;
  if (p === "night") document.querySelector('meta[name="theme-color"]').content = "#000000";
} catch (e) {}
