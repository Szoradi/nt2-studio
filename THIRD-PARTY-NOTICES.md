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

## Example tunes and the instrument kit

- Files: everything under `public/examples/` (208 songs and `index.json`),
  `public/kit/instruments.json` and `kit/report.txt`
- These are tunes made with NinjaTracker 2 by other musicians, and instruments taken from those
  tunes. They were rebuilt from the musicians' `.sid` files by `scripts/extract-instruments.ts`;
  the `.sid` files themselves are not part of this project.
- Each tune remains © its author. The MIT licence in `LICENSE` does not cover them, and this
  project has no licence from the authors to grant anyone else. They are included, with credit,
  so that the tunes can be studied and the instruments tried in the editor.
- Credit is kept with the data: every entry in `public/examples/index.json` carries the title,
  author and release line from its `.sid`, and every instrument in the kit names the tune it
  came from.
- The editor does not save or export a tune loaded from Examples, except the tunes of
  László Vincze (Vincenzo) and Péter Nagy-Miklós (NecroPolo), who allow theirs to be changed and
  saved. Those, and the four tunes from the NinjaTracker disk, are saved as a copy: the bundled
  files are never written to.
- An author who does not want a tune included can have it removed.
- Authors: Jaakko Viitalähde (Aomeba), Sarah Jane Avory, Bartosz Zolynski (Bago Zonde),
  Barney Gumble, Lasse Öörni (Cadaver), Sean McKenzie (Fade), Alex Brem (freQvibez),
  Gylby Dynnyri, Mark Waldaukat (Heinmück), Hein Holt, Jake Manley (Jellica),
  Jaymz Julian (A Life in Hell), Pedro (La Vaca Blasa), Mauro Staci (MAT64), Vanja Utne (Mermaid),
  Adam Morton, Péter Nagy-Miklós (NecroPolo), Marc van den Bovenkamp (No-XS),
  Simone Bevilacqua (Saimo), Jan Diabelez Arent Harries (SIDwave), Jan Rödig (Spider Jerusalem),
  Alexander Ney (Taxim), László Vincze (Vincenzo), Roy Johan Widding (Rotteroy), and the unnamed
  author of two "Secret of Monkey Island" game tunes.

## Songs

`songs/second-strike.nt2` and `songs/claude2.nt2` use the instruments (tables and commands) of
the MW4TITLE example tune from the NinjaTracker disk, with new patterns and tracks.
