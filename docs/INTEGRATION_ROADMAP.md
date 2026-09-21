# Hoot integration roadmap

Planned integrations are source adapters, not a second composition
architecture. `ContextLedger`, `TargetResolver`, `IntentCompositionEngine`,
and `ObjectRegistry` already define the boundaries that an adapter must use.
An adapter may add evidence or resolve a target, but it may not authorize an
action, rewrite explicit user evidence, or turn a lookup miss into a negative
fact.

## Implemented boundaries

| Source | Implementation | Permission boundary |
| --- | --- | --- |
| Foreground app and window | `ContextEngine` plus `ActiveWindowEngine` | Session enablement and app approval |
| Focused Accessibility element | One bounded macOS Accessibility query after an approved window change | macOS Accessibility permission |
| Active-window image | One bounded window capture | macOS Screen Recording permission and approved window |
| Installed apps and recent files | Bounded local warmup in `TargetResolver` | Local filesystem access to standard directories |
| Personal vocabulary | Bounded environment-provided lexicon | Local configuration only |
| Task references | `TaskStore` and `ObjectRegistry` | Host revalidation before execution |

These sources are enough to exercise the open-world composition path without
inventing a cloud connector or scanning the whole computer.

## Later adapters

Each item below can be added independently. The existing resolver constructor
already accepts contacts, directories, and bookmarks.
The work consists of implementing one source, mapping its records to stable
IDs, adding permission and freshness handling, and adding fixture tests.

1. **Browser selection and DOM text.** Add a browser extension or an explicit
   `activeTab` bridge that returns selected text and a bounded element reference.
   The bridge must be user-approved for the current tab; it must not run as a
   background page crawler.
2. **Contacts and organization directories.** Add a read-only provider for
   macOS Contacts or an explicitly configured directory API. The provider can
   return several matches for an abbreviated name; `TargetResolver` can then
   show a clarification card without treating message history as a
   requirement.
3. **Bookmarks and browser history.** Add a read-only browser-data adapter
   that returns titles and URLs on demand. History must remain weak context and
   must not limit open-world website resolution.
4. **Web search.** Add an explicitly enabled remote resolver for a novel
   website, person, or public topic. The resolver returns only bounded
   metadata and links, record the source, and leave the final intent decision
   with the host and user.
5. **Application adapters.** Add an opt-in context adapter only when a surface
   needs structured metadata that a screenshot and the standard Computer Use
   loop cannot provide. The adapter must not add application-specific decoder
   branches or hardcoded launch behavior.

## Why this is not a rewrite

The decoder does not need a new prompt for each source. The adapter supplies a
bounded `ContextReference` or `ResolvedTarget`, the ranker applies it as weak
evidence, and `TaskCompiler` remains responsible for the final natural-language
task. The executor still revalidates references and owns consequential-action
confirmation.

The work becomes larger only when a source needs a new platform permission,
account authentication, browser packaging, or a privacy review. Those costs
belong to the source integration and do not require changing gaze hit testing,
card layout, request coordination, or Astra execution.

## Delivery order

1. Browser selected-text bridge, because it improves document and web tasks
   while keeping the context payload small.
2. Contacts/directory provider, because it resolves abbreviated recipients
   without relying on message history.
3. Bookmarks/history provider, because it improves website recall without
   making context an allowlist.
4. Optional web resolver, only after the local and permission-scoped sources
   meet their latency and quality gates.

Every adapter ships with offline fixtures and an opt-in live check. A live
integration fails explicitly when permission, authentication, or freshness
checks fail. It does not silently fall back to screenshots, pointer input, or a
different entity.
