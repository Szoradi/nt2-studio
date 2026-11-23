# Third-party parts

The MIT licence in `LICENSE` covers the NT2 Studio code written for this project. The parts
below come from other authors and keep their own terms.

## WebSid (Tiny'R'Sid)

- Files: `public/websid/backend_websid.js`, `public/websid/websid.wasm`
- © Jürgen Wothke, <https://bitbucket.org/wothke/websid>
- Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0
  (<https://creativecommons.org/licenses/by-nc-sa/4.0/>)
- These are the project's prebuilt WebAssembly and glue code, unmodified except that the
  ScriptNodePlayer adapter class is removed from the glue code.

Because the app ships with WebSid, NT2 Studio as distributed here (including the hosted version)
may only be used non-commercially, and versions that include WebSid must keep its attribution and
licence.

## NinjaTracker V2.03

- Files: `public/examples.d64` (the disk image from the distribution, with the editor and four
  example tunes), `scripts/fixtures/gamemusic.bin` (its packed example tune), and the
  playroutine source in `src/core/playersrc.ts`
- The player template in `src/core/export4k.ts` is derived from that playroutine.
- © Cadaver (Lasse Öörni), <http://covertbitops.c64.org>
- Terms, from the distribution's readme: "NinjaTracker is freeware; customization is allowed and
  recommended."

## Songs

`songs/second-strike.nt2` and `songs/claude2.nt2` use the instruments (tables and commands) of
the MW4TITLE example tune from the NinjaTracker disk, with new patterns and tracks.
