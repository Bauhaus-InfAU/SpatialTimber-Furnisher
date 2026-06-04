# custom/

Power-user preset folder. Files here override the shipped defaults at build time.

**These files are gitignored** — they stay local and never appear in the shared repo.

## How to use

1. Copy `../default/furniture_library.json` here and edit it.
2. Copy `../default/placement_order.md` here and edit it.
3. Pass the loaded objects via `opts.library` / `opts.pipeline` in your call to `runRoomPipeline`.

Or just pass custom objects directly — no file needed:

```ts
import { parsePipelineMd, defaultLibrary } from "../../library";
import { runRoomPipeline } from "../../engine";

const myPipeline = parsePipelineMd(`
## Bedroom
1. Wardrobe
2. Bed
`);

const result = runRoomPipeline(room, aptType, { pipeline: myPipeline });
```
