-- Each model call's route (openrouter | xai: X search stays on xAI direct) and the upstream provider OpenRouter reports
-- for it (null on the direct route). A reply from any provider other than the model's own is refused (src/llm.ts).
alter table llm_call add column via text;
alter table llm_call add column provider text;
