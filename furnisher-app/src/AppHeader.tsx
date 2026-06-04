// AppHeader — canonical SpatialTimber in-app lockup, ported from the
// design-system Aufstockung Assistent kit (Header.jsx) and adapted for the
// Furnisher module. Brand mark + wordmark + module glyph + descriptor on the
// left; project / source links + funder logos on the right.

const GITHUB_URL = "https://github.com/neobim/SpatialTimber-Furnisher";

export function AppHeader() {
  return (
    <header className="app-header">
      <div className="brand">
        <div className="st-lockup">
          <span className="logo">
            <img className="st-mark" src="/brand/logo-accent.svg" alt="SpatialTimber" />
            <span className="wm">
              <span className="s-spatial">Spatial</span>
              <span className="s-timber">Timber</span>
            </span>
          </span>
          <span className="lockup-div" />
          <span className="st-mod">
            <span className="glyph-tile">
              <img src="/brand/glyph-furnisher.svg" alt="" aria-hidden="true" />
            </span>
            <span className="mod-text">
              <span className="mod-kicker">Layout · Furnishing</span>
              <span className="mod-name">Furnisher</span>
            </span>
          </span>
        </div>
        <span className="st-byline">
          <b>Bauhaus-Universität Weimar</b> &nbsp;&amp;&nbsp; <b>TU Dresden</b>
        </span>
      </div>

      <div className="header-right">
        <div className="links">
          <a className="link-pill" href={GITHUB_URL} target="_blank" rel="noopener noreferrer" title="View source on GitHub">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
            </svg>
            GitHub
          </a>
        </div>
        <div className="hr-divider" />
        <div className="funded">
          <span className="funded-lbl">Funded by</span>
          <div className="funded-logos">
            <a href="https://www.bmwsb.bund.de" target="_blank" rel="noopener noreferrer" title="Bundesministerium für Wohnen, Stadtentwicklung und Bauwesen">
              <img className="logo-bmwsb" src="/brand/bmwsb_logo.svg" alt="BMWSB" />
            </a>
            <a href="https://www.zukunftbau.de" target="_blank" rel="noopener noreferrer" title="Zukunft Bau — Fördern, Forschen, Entwickeln">
              <img className="logo-zb" src="/brand/zukunftbau_logo.png" alt="Zukunft Bau" />
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}
