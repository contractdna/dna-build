// /models copy. The model ids come from models.json, which engine/scripts/models-table.ts generates from the engine's
// registry (engine/models.json) and the image studio's pinned models; web/test/models.test.mjs keeps them in step.
// Rows are shown in this order.

export const PAGE = {
  metaTitle: "Models · DNA",
  metaDescription: "Which AI model does each job in DNA, its exact model id, its provider and its backup.",
  title: "Models",
  lede: "Every job runs on a frontier model picked for it. These are the defaults: the brain can swap a model after a public tryout on fixed tests, and swapping the brain itself needs the Safe.",
  tableTitle: "Who does what",
  source: "Generated from engine/models.json and the image studio's settings (engine/src/studio.ts). Each swap is a signed model-change record. The two image studio models run outside the enclave and are set in the studio's own settings, not through a swap.",
};

export const PARTS: { part: string; name: string; job: string }[] = [
  { part: "brain", name: "Brain", job: "Makes the judgement calls: build a game or not, ship a build or not, retire a game, decide each idea round's outcome and reward, propose a model swap." },
  { part: "main", name: "Fee loop", job: "Writes the fee loop's hypotheses and makes its go or no-go calls." },
  { part: "research", name: "Research", job: "Searches the web and X for fee research. Its findings are treated as untrusted." },
  { part: "intake", name: "Idea reader", job: "Reads ideas posted on X and sorts them: fee, build, impossible, joke, shill or spam. Also sorts replies to its account." },
  { part: "x-voice", name: "Voice", job: "Writes DNA's posts." },
  { part: "x-scout", name: "X scout", job: "Reads recent posts from a fixed list of X accounts." },
  { part: "x-audit", name: "X audit", job: "Once a week, reads DNA's own posts for stale patterns the voice must stop using, and ranks each post's candidates that already passed every filter." },
  { part: "redteam", name: "Red team", job: "Attacks each fee experiment before it goes further." },
  { part: "gate", name: "Red-team gate", job: "A harder red-team pass before a canary or a promotion." },
  { part: "narrate", name: "Narrator", job: "Writes short notes, lessons and the journal." },
  { part: "studio-image", name: "Image studio", job: "Makes the art for post images, outside the enclave." },
  { part: "studio-rubric", name: "Image scoring", job: "Scores each image the studio makes against the style it asked for and against recent posts. Low scores are dropped." },
  { part: "vision", name: "Image check", job: "Checks the studio's art again inside the enclave. Any digits, logos, addresses, unsafe content or text other than a meme's own caption, and the art is rejected." },
  { part: "dev-lead", name: "Dev team: lead", job: "Plans a game build: its interface, tasks and tests." },
  { part: "dev-worker", name: "Dev team: workers", job: "Write the game's contract, page and tests." },
  { part: "dev-tester", name: "Dev team: tester", job: "Attacks the build with its own tests." },
  { part: "dev-fixer", name: "Dev team: fixer", job: "Repairs what the tester found, up to 3 rounds." },
  { part: "dev-review", name: "Dev team: reviewer", job: "Checks the finished build before the brain decides to ship it or not." },
];
