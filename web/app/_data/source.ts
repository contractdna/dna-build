// The one seam between pages and data. Mock mode (default): sample data. LIVE (NEXT_PUBLIC_LIVE=1): chain-backed
// getters read the indexer's Postgres and the engine's hash-chained log (./live). LIVE never falls back to sample data:
// an engine getter with no record yet returns its empty shape, and the page says so in the present tense.
import { LIVE } from "./flags";
import * as live from "./live";
import * as m from "./mock";
import type { Announcement, Bounty, Clone, SeqEvent, Experiment, Hex, Idea, JournalEntry, Leakage, MemoryEntry, Pipeline, QueuedOp, Thread } from "./types";

const entries = <T,>(get: () => Promise<T[]>) => async () => ({ entries: await get() });

export const getModules = LIVE ? live.getModules : async () => m.modules;
export const getLaunchedAt = LIVE ? live.getLaunchedAt : async (): Promise<number | null> => null;
/** The newest reasoning thread; null until the engine wrote one. */
export const getThread = async (): Promise<Thread | null> => (LIVE ? (await live.getThread()) ?? null : m.thread);
export const getLab = LIVE ? live.getLab : async (): Promise<{ experiments: Experiment[]; pipeline: Pipeline }> => ({ experiments: m.experiments, pipeline: m.pipeline });
export const getMemory = entries<MemoryEntry>(LIVE ? live.getMemory : async () => m.memory);
export const getEpochs = LIVE ? live.getEpochs : async () => m.epochs;
export const getAutonomy = LIVE ? live.getAutonomy : async () => ({ levels: m.autonomy, current: m.currentLevel, interventions: m.interventions, attested: false });
export const getIdeas = LIVE ? live.getIdeas : async (): Promise<{ ideas: Idea[]; start: string | null; roundMs: number }> => ({ ideas: m.ideas, start: m.ideaMarketStart, roundMs: m.ideaRoundMs });
/** IdeaMarket and ConvictionVault addresses (LIVE; none in mock mode). */
export const getContracts = LIVE ? live.getContracts : async (): Promise<{ ideaMarket: Hex | null; convictionVault: Hex | null }> => ({ ideaMarket: null, convictionVault: null });
/** /proposals: what the engine decided about each X mention it read (LIVE; none in mock mode). */
export const getIntake = LIVE ? live.getIntake : async (): Promise<live.IntakeSummary> => ({ total: 0, ideas: 0, reasons: [] });
/** LIVE: no bounty data source yet (BountyBoard events are not indexed): an empty board, never the sample rows. */
export const getBounties = async (): Promise<Bounty[]> => (LIVE ? [] : m.bounties);
export const getTreasury = LIVE ? live.getTreasury : async () => ({ vaults: m.vaults, split: m.split, flows: m.flows, limits: m.limits });
export const getRules = async () => m.rules;
export const getAnnouncements = entries<Announcement>(LIVE ? live.getAnnouncements : async () => m.announcements);
/** The Sequencer's public story (LIVE; nothing before its first announcement). */
export const getSeqFeed = LIVE ? live.getSeqFeed : async (_limit?: number): Promise<SeqEvent[]> => [];
export const getJournal = entries<JournalEntry>(LIVE ? live.getJournal : async () => m.journal);
export const getSecurity = LIVE ? live.getSecurity : async () => m.security;
export const getQueue = LIVE ? live.getQueue : async (): Promise<QueuedOp[]> => [];
export const getXp = LIVE ? live.getXp : async (): Promise<live.XpRow[]> => [];
/** /play: live game state from the game contracts (undefined in mock mode, or before the indexer has read them). */
export const getPlay = LIVE ? live.getPlay : async (): Promise<live.PlayLive | undefined> => undefined;
/** /play/draw/<id>: one settled jackpot draw (LIVE only; mock mode has no draws). */
export const getDraw = LIVE ? live.getDraw : async (_id: number): Promise<live.DrawLive | undefined> => undefined;
/** /trade: the hook pool's token + hook (LIVE; undefined in mock mode or while the manifest is unreadable). */
export const getPool = LIVE ? live.getPool : async (): Promise<{ token: Hex; hook: Hex } | undefined> => undefined;
/** /trade: DNA pools without DNA's hook and the newest leakage window (LIVE; none in mock mode). */
export const getClones = LIVE ? live.getClones : async () => ({ clones: [] as Clone[], leakage: null as Leakage | null });
/** /proof: the newest anchored roots (LIVE; none in mock mode). */
export const getProofChain = LIVE ? live.getProofChain : async () => ({ anchors: [] as live.AnchorRow[] });
/** /proof: the persona, context and newest self-file hashes (LIVE; nothing before the engine's first self record). */
export const getProofBrain = LIVE ? live.getProofBrain : async (): Promise<live.ProofBrain | null> => null;
