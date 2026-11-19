alter table public.usage_events
  add column if not exists reasoning_tokens integer,
  add column if not exists incomplete_reason text;

comment on column public.usage_events.reasoning_tokens is
  'Reasoning tokens reported by the model. On gpt-5 they count against max_output_tokens.';

comment on column public.usage_events.incomplete_reason is
  'Responses API incomplete_details.reason when the turn stopped early, such as max_output_tokens.';
