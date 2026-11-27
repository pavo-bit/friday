# Agent Orchestration & Tool Calling

## Execution Lifecycle

1. **Clarification Check**: Resumes pending clarifications via `ClarificationEngine`.
2. **Request Understanding**: Classifies intent, entities, and missing parameters (`RequestUnderstandingEngine`).
3. **Context Resolution**: Retrieves bounded history and categorized memories from SQLite (`ContextResolutionEngine` + `MemoryManager`).
4. **Deterministic / Planned Execution**: Matches direct tools or plans multi-step capabilities via `CapabilityDiscoveryEngine` and `ToolPlanner`.
5. **OpenRouter Inference & Tool Loop**:
   - `AssistantBrain` invokes `OpenRouterProvider.chat()` with `ToolRegistry.toToolSchemas()`.
   - Up to `MAX_TOOL_ITERATIONS = 5` iterations with duplicate `(tool, args)` loop detection.
   - Every tool call passes through `ToolRegistry.execute()` with `approvedHighRisk: false` so a cloud model can never auto-approve destructive actions.
6. **Verification & Memory Update**: Results are verified, secrets redacted, and persisted to SQLite.
