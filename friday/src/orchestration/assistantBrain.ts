// ============================================================
// FRIDAY — Assistant Brain
// Integrates Personality, Memory Context, Ollama Tool Calling,
// and Deterministic Natural-Language Action Dispatch
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { getPersonalityEngine } from '../intelligence/personality';
import { getAdaptivePersonalityEngine } from '../personality/personalityEngine';
import { selectResponseDepth } from '../personality/responseDepth';
import { InteractionChannel, PersonalityMetadata } from '../personality/personalityTypes';
import { getPersonalIdentityService } from '../identity/identityService';
import { getProjectContextService } from '../identity/projectContextService';
import { getContinuousLearningEngine } from '../learning/learningEngine';
import { getOllamaClient, OllamaChatMessage } from './ollamaClient';
import { getToolRegistry, ToolExecutionResult } from './toolRegistry';
import { getCapabilityDiscoveryEngine } from './capabilityDiscovery';
import { getToolPlanner, ExecutionPlan } from './toolPlanner';
import { getBackgroundOrchestrator } from './backgroundOrchestrator';
import { getMonitoringEngine } from '../services/monitoringEngine';
import { getSchedulerService } from '../services/schedulerService';
import { getIntentParser } from '../intelligence/intentParser';
import { getTaskRouter } from './taskRouter';
import { getRequestUnderstandingEngine, AssistantRequest } from './requestUnderstanding';
import {
  getContextResolutionEngine,
  shouldPersistConversationToMemory,
} from './contextResolution';
import { getClarificationEngine } from './clarificationEngine';
import { synthesizeTaskOutcome } from './resultSynthesizer';
import { ActionType, RiskLevel, TaskResult } from '../shared/types';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('AssistantBrain');

export type ExecutiveDecision =
  | 'ANSWER_DIRECTLY'
  | 'ASK_CLARIFICATION'
  | 'DISCOVER_CAPABILITIES'
  | 'EXECUTE_PLAN'
  | 'RESUME_TASK'
  | 'REQUEST_APPROVAL'
  | 'SYNTHESIZE_RESULTS'
  | 'HANDLE_FAILURE';

export interface AssistantProcessOptions {
  actorId?: string;
  grantedPermissions?: readonly string[];
  channel?: InteractionChannel;
}

export interface AssistantProcessResponse extends TaskResult {
  toolResult?: ToolExecutionResult;
  plan?: ExecutionPlan;
  backgroundTaskId?: string;
  executiveDecision?: ExecutiveDecision;
  assistantRequest?: AssistantRequest;
  clarificationNeeded?: string;
  personalityMeta?: PersonalityMetadata;
  timingsMs?: {
    understanding: number;
    context: number;
    planning: number;
    total: number;
  };
}

export class AssistantBrain {
  /**
   * Process natural-language input through the Phase 10 Executive Brain lifecycle:
   * Clarification Check -> Request Understanding -> Context Resolution ->
   * Executive Decision -> Discovery/Planning/Execution -> Verification & Synthesis.
   */
  async process(
    text: string,
    sessionId?: string,
    approvedHighRisk = false,
    options?: AssistantProcessOptions
  ): Promise<AssistantProcessResponse> {
    const startTime = Date.now();
    const intentId = uuidv4();
    const store = await getMemoryStore();
    const personality = getPersonalityEngine();
    const profile = store.getPersonalityProfile();
    const registry = getToolRegistry();
    const actorId = options?.actorId || 'local';
    const conversationId = sessionId || 'default';
    const channel: InteractionChannel = options?.channel || 'text';
    let effectiveText = text.trim();

    const memoryPolicy = shouldPersistConversationToMemory(effectiveText);
    if (memoryPolicy.allow) {
      store.logConversation('user', effectiveText, undefined, sessionId, actorId, channel);
    }

    // 0. Persistent Clarification resumption (clarification NEVER grants approval/permission)
    const clarificationEngine = getClarificationEngine();
    const pendingClarification = await clarificationEngine.consumeAndMerge(
      actorId,
      conversationId,
      effectiveText
    );
    if (pendingClarification) {
      if (/^(cancel|never\s*mind|stop)\b/i.test(effectiveText)) {
        const res = await this.finish(
          intentId,
          effectiveText,
          `Okay ${profile.userName}, I've cancelled that pending request.`,
          true,
          'internal',
          RiskLevel.LOW,
          startTime,
          sessionId
        );
        return {
          ...res,
          executiveDecision: 'ANSWER_DIRECTLY',
          timingsMs: { understanding: 0, context: 0, planning: 0, total: Date.now() - startTime },
        };
      }
      effectiveText = pendingClarification.mergedRequest;
    }

    // 1. Request Understanding
    const tUnderstandStart = Date.now();
    const understood = getRequestUnderstandingEngine().understand({
      rawInput: effectiveText,
      actorId,
      conversationId,
      hasPendingClarification: false,
    });
    const understandingMs = Date.now() - tUnderstandStart;

    // 2. Underspecified / ambiguous request -> ask one concise clarification question
    if (understood.missingInformation.length > 0 && !pendingClarification) {
      const question = `Could you clarify the ${understood.missingInformation.join(' and ')} before I proceed, ${profile.userName}?`;
      await clarificationEngine.setPending({
        actorId,
        conversationId,
        originalRequestId: understood.requestId,
        originalRequest: effectiveText,
        structuredRequest: understood,
        missingFields: understood.missingInformation,
        question,
      });
      const res = await this.finish(
        intentId,
        effectiveText,
        question,
        false,
        'internal',
        RiskLevel.LOW,
        startTime,
        sessionId
      );
      return {
        ...res,
        executiveDecision: 'ASK_CLARIFICATION',
        assistantRequest: understood,
        clarificationNeeded: question,
        timingsMs: { understanding: understandingMs, context: 0, planning: 0, total: Date.now() - startTime },
      };
    }

    // 3. Greetings, Compound Greeting+Command requests & Farewells
    const greetingPrefixMatch = effectiveText.match(
      /^(?:(?:hi|hello|hey|good\s*(?:morning|afternoon|evening|night)|yo|greetings)(?:\s*,?\s*friday)?[!.,\s]*)(.*)$/i
    );
    if (greetingPrefixMatch) {
      const remainder = (greetingPrefixMatch[1] || '').trim();
      const watchers = await getMonitoringEngine().listWatchers();
      const unhealthy = watchers.filter(
        (w) => w.status === 'active' && (w.health === 'offline' || w.health === 'degraded')
      ).length;
      const pendingReminders = (await getSchedulerService().listReminders('pending')).length;
      const ollama = await getOllamaClient().checkStatus(1_000);

      const greetingText = personality.buildGreeting(profile, {
        pendingRemindersCount: pendingReminders,
        unhealthyWatchersCount: unhealthy,
        allSystemsHealthy: unhealthy === 0 && ollama.reachable,
      });

      if (!remainder || remainder.length < 3) {
        const res = await this.finish(
          intentId,
          effectiveText,
          greetingText,
          true,
          'internal',
          RiskLevel.LOW,
          startTime,
          sessionId
        );
        return {
          ...res,
          executiveDecision: 'ANSWER_DIRECTLY',
          assistantRequest: understood,
          timingsMs: { understanding: understandingMs, context: 0, planning: 0, total: Date.now() - startTime },
        };
      }

      const compoundTool = this.matchDirectTool(remainder, profile.timezone);
      if (compoundTool) {
        const toolRes = await registry.execute(compoundTool.tool, compoundTool.args, {
          actor: actorId,
          approvedHighRisk,
          timezone: profile.timezone,
        });
        const actionText = toolRes.success
          ? personality.formatVerifiedSuccess(toolRes.message, toolRes.verified)
          : personality.formatFailure(toolRes.error || toolRes.message);
        const combined = `${greetingText}\n\n${actionText}`;
        const res = await this.finish(
          intentId,
          effectiveText,
          combined,
          toolRes.success,
          'internal',
          RiskLevel.LOW,
          startTime,
          sessionId
        );
        return {
          ...res,
          toolResult: toolRes,
          executiveDecision: 'EXECUTE_PLAN',
          assistantRequest: understood,
          timingsMs: { understanding: understandingMs, context: 0, planning: 0, total: Date.now() - startTime },
        };
      }
    }

    if (understood.intent === 'farewell') {
      const output = personality.buildFarewell(profile, effectiveText);
      const res = await this.finish(
        intentId,
        effectiveText,
        output,
        true,
        'internal',
        RiskLevel.LOW,
        startTime,
        sessionId
      );
      return {
        ...res,
        executiveDecision: 'ANSWER_DIRECTLY',
        assistantRequest: understood,
        timingsMs: { understanding: understandingMs, context: 0, planning: 0, total: Date.now() - startTime },
      };
    }

    // 4. Bounded Context Resolution
    const tCtxStart = Date.now();
    const ctxEngine = getContextResolutionEngine();
    const boundedCtx = await ctxEngine.resolve(understood);
    const contextMs = Date.now() - tCtxStart;

    // 4.5. Adaptive Personality & Response Depth Selection (Phase 13)
    const adaptiveEngine = getAdaptivePersonalityEngine();
    if (understood.persistOverride) {
      store.saveDigitalIdentitySettings(actorId, {
        ...(understood.explicitPersonalityOverride
          ? { defaultPersonality: understood.explicitPersonalityOverride }
          : {}),
        ...(understood.explicitDepthOverride
          ? { answerDetail: understood.explicitDepthOverride }
          : {}),
      });
    }
    const identitySettings = store.getDigitalIdentitySettings(actorId);
    const convState = store.getConversationContextState(actorId, conversationId);
    const personalIdentity = await getPersonalIdentityService().getProfile(actorId);
    let activeProject = await getProjectContextService().getActiveProject(actorId);

    // Handle explicit project context switch (Phase 13.8)
    if (understood.projectSwitchTarget) {
      const switchRes = await getProjectContextService().switchProject(actorId, understood.projectSwitchTarget);
      if (switchRes.switched && switchRes.project) {
        activeProject = switchRes.project;
        const msg = `Switched active project context to "${switchRes.project.projectName}"${switchRes.project.techStack.length > 0 ? ` (${switchRes.project.techStack.join(', ')})` : ''}, ${personalIdentity.preferredAddress}.`;
        const res = await this.finish(
          intentId,
          effectiveText,
          msg,
          true,
          'internal',
          RiskLevel.LOW,
          startTime,
          sessionId,
          actorId,
          channel
        );
        return {
          ...res,
          executiveDecision: 'ANSWER_DIRECTLY',
          assistantRequest: understood,
          timingsMs: { understanding: understandingMs, context: contextMs, planning: 0, total: Date.now() - startTime },
        };
      }
    }

    // Continuous learning: record explicit user corrections / preferences when permitted
    if (identitySettings.memoryAutoLearn && personalIdentity.privacy.allowLearning) {
      const correctionMatch = effectiveText.match(/^(?:actually,?\s+|correction:\s*|remember\s+(?:that\s+)?)(.+)$/i);
      if (correctionMatch && correctionMatch[1].trim().length >= 8) {
        await getContinuousLearningEngine().recordCorrection({
          actorId,
          subject: activeProject ? `${activeProject.projectName} user note` : 'user preference / correction',
          correction: correctionMatch[1].trim(),
          projectName: activeProject?.projectName,
        });
      }
    }

    const personalitySelection = adaptiveEngine.selectPersonality({
      rawInput: effectiveText,
      category: understood.conversationalCategory,
      complexity: understood.complexity,
      intentConfidence: understood.confidence,
      settings: identitySettings,
      explicitOverride: understood.explicitPersonalityOverride,
      temporarySessionProfile: convState.temporaryPersonality,
      hasActiveProjectContext: boundedCtx.categorizedMemories.projects.length > 0,
      isReturningTopic: boundedCtx.isReturningTopic,
    });

    const depthSelection = selectResponseDepth({
      rawInput: effectiveText,
      category: understood.conversationalCategory,
      complexity: understood.complexity,
      configuredDetail: identitySettings.answerDetail,
      explicitDepthOverride: understood.explicitDepthOverride,
      temporarySessionDepth: convState.temporaryDepth,
      channel,
    });

    if (identitySettings.conversationContinuity) {
      const topicHint = effectiveText.slice(0, 80);
      store.saveConversationContextState(actorId, conversationId, {
        activeTopic: topicHint,
        activePersonality: personalitySelection.primaryProfile,
      });
    }

    const personalityMeta: PersonalityMetadata = {
      activeProfile: personalitySelection.primaryProfile,
      secondaryProfile: personalitySelection.secondaryProfile,
      configuredMode: personalitySelection.configuredMode,
      communicationStyle: personalitySelection.communicationStyle,
      depth: depthSelection.depth,
      isTemporaryOverride: personalitySelection.isTemporaryOverride || depthSelection.isTemporaryOverride,
      selectionReason: `${personalitySelection.reason} ${depthSelection.reason}`.trim(),
    };

    // 5. Task Resume & Follow-Up Continuity
    if (understood.intent === 'task_resume') {
      const resolvedTask = ctxEngine.resolveFollowUpTask(boundedCtx, 'active_or_waiting');
      if (!resolvedTask.resolved) {
        const msg = resolvedTask.clarification || 'No paused task found to resume.';
        const res = await this.finish(intentId, effectiveText, msg, false, 'internal', RiskLevel.LOW, startTime, sessionId);
        return {
          ...res,
          executiveDecision: resolvedTask.ambiguous ? 'ASK_CLARIFICATION' : 'HANDLE_FAILURE',
          assistantRequest: understood,
          clarificationNeeded: resolvedTask.ambiguous ? msg : undefined,
          timingsMs: { understanding: understandingMs, context: contextMs, planning: 0, total: Date.now() - startTime },
        };
      }
      const task = await getBackgroundOrchestrator().getTask(resolvedTask.taskId!, actorId);
      const msg = task
        ? `Task "${task.originalRequest}" (${task.id}) is currently ${task.status} (${task.progress}%).${task.status === 'WAITING_FOR_APPROVAL' ? ' Please approve or reject the pending bound approval to continue.' : ''}`
        : 'Task not found.';
      const res = await this.finish(intentId, effectiveText, msg, Boolean(task), 'internal', RiskLevel.LOW, startTime, sessionId);
      return {
        ...res,
        backgroundTaskId: task?.id,
        executiveDecision: 'RESUME_TASK',
        assistantRequest: understood,
        timingsMs: { understanding: understandingMs, context: contextMs, planning: 0, total: Date.now() - startTime },
      };
    }

    if (understood.intent === 'follow_up' && boundedCtx.recentPresentations.length > 0) {
      const latestPres = boundedCtx.recentPresentations[0];
      const msg = `Following up on "${latestPres.title}" (${latestPres.verificationStatus}): ${latestPres.summary}`;
      const res = await this.finish(intentId, effectiveText, msg, true, 'internal', RiskLevel.LOW, startTime, sessionId);
      return {
        ...res,
        executiveDecision: 'SYNTHESIZE_RESULTS',
        assistantRequest: understood,
        timingsMs: { understanding: understandingMs, context: contextMs, planning: 0, total: Date.now() - startTime },
      };
    }

    // 6. Structured Capability Discovery & Multi-Tool Planning (skip for pure conversational / knowledge intents)
    const tPlanStart = Date.now();
    const discovery =
      understood.intent === 'knowledge_question'
        ? {
            request: effectiveText,
            normalizedIntent: effectiveText,
            requiresTools: false,
            isPureGreeting: false,
            hasCompoundGreeting: false,
            matched: [],
            unavailable: [],
            missingInputs: [],
            ambiguous: false,
            usedLlm: false,
          }
        : await getCapabilityDiscoveryEngine().discover({
            request: effectiveText,
            conversationId: sessionId,
            conversationHistory: boundedCtx.recentMessages.map((m) => ({ role: m.role, content: m.content })),
            timezone: profile.timezone,
            useLlmFallback: false,
          });

    if (discovery.clarificationNeeded && discovery.matched.length <= 1) {
      await clarificationEngine.setPending({
        actorId,
        conversationId,
        originalRequestId: understood.requestId,
        originalRequest: effectiveText,
        structuredRequest: understood,
        missingFields: discovery.missingInputs.flatMap((m) => m.fields),
        question: discovery.clarificationNeeded,
      });
      const res = await this.finish(
        intentId,
        effectiveText,
        discovery.clarificationNeeded,
        false,
        'internal',
        RiskLevel.LOW,
        startTime,
        sessionId
      );
      return {
        ...res,
        executiveDecision: 'ASK_CLARIFICATION',
        assistantRequest: understood,
        clarificationNeeded: discovery.clarificationNeeded,
        timingsMs: {
          understanding: understandingMs,
          context: contextMs,
          planning: Date.now() - tPlanStart,
          total: Date.now() - startTime,
        },
      };
    }

    if (discovery.unavailable.length > 0 && discovery.matched.length === 0) {
      const synth = synthesizeTaskOutcome({
        userName: profile.userName,
        steps: [],
        unavailableCapabilities: discovery.unavailable.map((u) => u.name),
      });
      const res = await this.finish(
        intentId,
        effectiveText,
        synth.summary,
        false,
        'internal',
        RiskLevel.LOW,
        startTime,
        sessionId
      );
      return {
        ...res,
        executiveDecision: 'HANDLE_FAILURE',
        assistantRequest: understood,
        timingsMs: {
          understanding: understandingMs,
          context: contextMs,
          planning: Date.now() - tPlanStart,
          total: Date.now() - startTime,
        },
      };
    }

    if (discovery.matched.length > 1) {
      const plan = await getToolPlanner().createPlan(discovery, { conversationId: sessionId });
      const planningMs = Date.now() - tPlanStart;
      if (!plan.valid) {
        const errMsg = plan.clarificationNeeded || plan.validationErrors.join(' ');
        const res = await this.finish(
          intentId,
          effectiveText,
          personality.formatFailure(errMsg),
          false,
          'internal',
          RiskLevel.LOW,
          startTime,
          sessionId
        );
        return {
          ...res,
          plan,
          executiveDecision: 'HANDLE_FAILURE',
          assistantRequest: understood,
          timingsMs: { understanding: understandingMs, context: contextMs, planning: planningMs, total: Date.now() - startTime },
        };
      }

      const submitted = await getBackgroundOrchestrator().submitPlan(plan, {
        ownerId: actorId,
        conversationId: sessionId,
        approvedHighRisk,
        grantedPermissions: options?.grantedPermissions,
      });

      const acceptedMsg = `I've started that in the background, ${profile.userName} (Task ${submitted.taskId}, ${plan.steps.length} steps). I'll notify you as each step completes.`;
      const res = await this.finish(
        intentId,
        effectiveText,
        acceptedMsg,
        true,
        'internal',
        RiskLevel.LOW,
        startTime,
        sessionId
      );
      return {
        ...res,
        plan,
        backgroundTaskId: submitted.taskId,
        executiveDecision: 'EXECUTE_PLAN',
        assistantRequest: understood,
        timingsMs: { understanding: understandingMs, context: contextMs, planning: planningMs, total: Date.now() - startTime },
      };
    }

    // 7. Deterministic Natural-Language Tool Matching (single tool, reliable offline)
    const directTool = this.matchDirectTool(effectiveText, profile.timezone);
    if (directTool) {
      const toolRes = await registry.execute(directTool.tool, directTool.args, {
        actor: actorId,
        approvedHighRisk,
        grantedPermissions: options?.grantedPermissions,
        timezone: profile.timezone,
      });
      const output = toolRes.success
        ? personality.formatVerifiedSuccess(toolRes.message, toolRes.verified)
        : personality.formatFailure(toolRes.error || toolRes.message);

      const res = await this.finish(
        intentId,
        effectiveText,
        output,
        toolRes.success,
        'internal',
        RiskLevel.LOW,
        startTime,
        sessionId
      );
      return {
        ...res,
        toolResult: toolRes,
        executiveDecision: toolRes.success ? 'SYNTHESIZE_RESULTS' : 'HANDLE_FAILURE',
        assistantRequest: understood,
        timingsMs: {
          understanding: understandingMs,
          context: contextMs,
          planning: Date.now() - tPlanStart,
          total: Date.now() - startTime,
        },
      };
    }

    // 7b. Single discovered capability from Phase 2/6/7 registry
    if (discovery.matched.length === 1) {
      const cap = discovery.matched[0].capability;
      const args = discovery.matched[0].suggestedArguments || {};
      const toolRes = await registry.execute(cap.id, args, {
        actor: actorId,
        approvedHighRisk,
        grantedPermissions: options?.grantedPermissions,
        timezone: profile.timezone,
      });
      const output = toolRes.success
        ? personality.formatVerifiedSuccess(toolRes.message, toolRes.verified)
        : personality.formatFailure(toolRes.error || toolRes.message);
      const res = await this.finish(
        intentId,
        effectiveText,
        output,
        toolRes.success,
        'internal',
        RiskLevel.LOW,
        startTime,
        sessionId
      );
      return {
        ...res,
        toolResult: toolRes,
        executiveDecision: toolRes.success ? 'SYNTHESIZE_RESULTS' : 'HANDLE_FAILURE',
        assistantRequest: understood,
        timingsMs: {
          understanding: understandingMs,
          context: contextMs,
          planning: Date.now() - tPlanStart,
          total: Date.now() - startTime,
        },
      };
    }

    // 8. Explicit legacy intents (WhatsApp, Email, Browser/App control, Memory store/recall)
    const parser = getIntentParser();
    const parsedIntent = await parser.parse(effectiveText);
    const legacyHandled = new Set<ActionType>([
      ActionType.SEND_WHATSAPP,
      ActionType.OPEN_BROWSER,
      ActionType.BROWSER_NAVIGATE,
      ActionType.OPEN_APP,
      ActionType.CLOSE_APP,
      ActionType.PC_CONTROL,
      ActionType.TAKE_SCREENSHOT,
      ActionType.DRAFT_EMAIL,
      ActionType.SEND_EMAIL,
      ActionType.READ_EMAIL,
      ActionType.SUMMARIZE_THREAD,
      ActionType.TRANSLATE_MESSAGE,
      ActionType.MEMORY_STORE,
      ActionType.MEMORY_RECALL,
      ActionType.SET_PREFERENCE,
    ]);

    if (legacyHandled.has(parsedIntent.action) && parsedIntent.confidence >= 0.75) {
      const routed = await getTaskRouter().route(parsedIntent);
      if (memoryPolicy.allow) {
        store.logConversation('assistant', routed.output || routed.error || '', parsedIntent.action, sessionId);
      }
      return {
        ...routed,
        executiveDecision: routed.success ? 'EXECUTE_PLAN' : 'HANDLE_FAILURE',
        assistantRequest: understood,
        timingsMs: {
          understanding: understandingMs,
          context: contextMs,
          planning: Date.now() - tPlanStart,
          total: Date.now() - startTime,
        },
      };
    }

    // 9. Local Ollama Structured Tool Calling & Natural Conversation Generation (Phase 13)
    const ollama = getOllamaClient();
    const ollamaStatus = await ollama.checkStatus(1_200);
    if (ollamaStatus.reachable && ollamaStatus.modelAvailable) {
      const systemPrompt = adaptiveEngine.buildAdaptiveSystemPrompt({
        legacyProfile: profile,
        preferredAddress: personalIdentity.preferredAddress,
        activeProject,
        selection: personalitySelection,
        depth: depthSelection,
        channel,
        memoryContext: {
          preferences: boundedCtx.categorizedMemories.preferences,
          projects: boundedCtx.categorizedMemories.projects,
          knowledge: boundedCtx.categorizedMemories.knowledge,
          activeTopic: boundedCtx.activeTopic,
        },
      });
      const history = boundedCtx.recentMessages;

      const messages: OllamaChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history.slice(0, -1).map((h) => ({
          role: (h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: h.content,
        })),
        { role: 'user', content: effectiveText },
      ];

      const chatRes = await ollama.chat({
        messages,
        tools: understood.intent === 'knowledge_question' ? undefined : registry.toOllamaSchemas(),
      });

      if (chatRes.ok) {
        if (chatRes.toolCalls.length > 0) {
          const toolMessages: OllamaChatMessage[] = [...messages];
          let lastToolResult: ToolExecutionResult | undefined;

          for (const call of chatRes.toolCalls) {
            const execRes = await registry.execute(call.name, call.arguments, {
              actor: actorId,
              approvedHighRisk: false, // Never allow LLM tool proposal to auto-approve high risk
              grantedPermissions: options?.grantedPermissions,
              timezone: profile.timezone,
            });
            lastToolResult = execRes;
            toolMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({
                verified: execRes.verified,
                message: execRes.message,
                data: execRes.data,
                error: execRes.error,
              }),
            });
          }

          const finalChat = await ollama.chat({ messages: toolMessages });
          const finalText = finalChat.ok && finalChat.content
            ? finalChat.content
            : lastToolResult?.message || 'Done.';

          const voiceSummary =
            channel === 'voice' || depthSelection.depth === 'DETAILED'
              ? adaptiveEngine.buildVoiceSummary(finalText, depthSelection.maxVoiceSentences)
              : undefined;

          const result = await this.finish(
            intentId,
            effectiveText,
            finalText,
            lastToolResult ? lastToolResult.success : true,
            'claw',
            RiskLevel.LOW,
            startTime,
            sessionId,
            actorId,
            channel
          );
          return {
            ...result,
            toolResult: lastToolResult,
            executiveDecision: 'SYNTHESIZE_RESULTS',
            assistantRequest: understood,
            personalityMeta: { ...personalityMeta, voiceSummary },
            timingsMs: {
              understanding: understandingMs,
              context: contextMs,
              planning: Date.now() - tPlanStart,
              total: Date.now() - startTime,
            },
          };
        }

        if (chatRes.content) {
          const voiceSummary =
            channel === 'voice' || depthSelection.depth === 'DETAILED'
              ? adaptiveEngine.buildVoiceSummary(chatRes.content, depthSelection.maxVoiceSentences)
              : undefined;

          const res = await this.finish(
            intentId,
            effectiveText,
            chatRes.content,
            true,
            'claw',
            RiskLevel.LOW,
            startTime,
            sessionId,
            actorId,
            channel
          );
          return {
            ...res,
            executiveDecision: 'ANSWER_DIRECTLY',
            assistantRequest: understood,
            personalityMeta: { ...personalityMeta, voiceSummary },
            timingsMs: {
              understanding: understandingMs,
              context: contextMs,
              planning: Date.now() - tPlanStart,
              total: Date.now() - startTime,
            },
          };
        }
      } else {
        log.warn('Ollama chat call failed', { error: chatRes.error });
      }
    }

    // 10. Graceful offline guidance tailored to active personality
    if (!ollamaStatus.reachable) {
      const honestMsg = adaptiveEngine.buildOfflineFallback({
        rawInput: effectiveText,
        userName: profile.userName,
        selection: personalitySelection,
        depth: depthSelection,
        ollamaStatusError: ollamaStatus.error,
        projectMemories: boundedCtx.categorizedMemories.projects,
      });
      const res = await this.finish(
        intentId,
        effectiveText,
        honestMsg,
        false,
        'internal',
        RiskLevel.LOW,
        startTime,
        sessionId,
        actorId,
        channel
      );
      return {
        ...res,
        executiveDecision: 'HANDLE_FAILURE',
        assistantRequest: understood,
        personalityMeta: {
          ...personalityMeta,
          voiceSummary: adaptiveEngine.buildVoiceSummary(honestMsg, 2),
        },
        timingsMs: {
          understanding: understandingMs,
          context: contextMs,
          planning: Date.now() - tPlanStart,
          total: Date.now() - startTime,
        },
      };
    }

    const routed = await getTaskRouter().route(parsedIntent);
    store.logConversation('assistant', routed.output || routed.error || '', parsedIntent.action, sessionId);
    return routed;
  }

  /**
   * Deterministic NLU mapping for core assistant tools (monitoring, reminders, status, time).
   */
  private matchDirectTool(
    text: string,
    timezone: string
  ): { tool: string; args: Record<string, unknown> } | null {
    const lower = text.toLowerCase();

    // Time / Date
    if (/\b(what\s*(time|day|date)|current\s*(time|date)|time\s*right\s*now)\b/i.test(lower)) {
      return { tool: 'get_current_time', args: { timezone } };
    }

    // System / Ollama status
    if (/\b(check\s+ollama|ollama\s+status)\b/i.test(lower)) {
      return { tool: 'check_ollama_status', args: {} };
    }
    if (/\b(system\s*status|status\s*check|health\s*check|are\s+you\s+(online|working))\b/i.test(lower)) {
      return { tool: 'get_system_status', args: {} };
    }

    // Dashboard / Server monitoring commands
    if (/\b(pause)\b.*\b(monitor|monitoring|watch|watcher|dashboard)\b/i.test(lower)) {
      return { tool: 'pause_dashboard_watch', args: {} };
    }
    if (/\b(resume)\b.*\b(monitor|monitoring|watch|watcher|dashboard)\b/i.test(lower)) {
      return { tool: 'resume_dashboard_watch', args: {} };
    }
    if (/\b(stop)\b.*\b(monitor|monitoring|watch|watching|watcher|dashboard)\b/i.test(lower)) {
      return { tool: 'stop_dashboard_watch', args: {} };
    }
    if (/\b(what\s+are\s+you\s+monitoring|list\s+watchers|active\s+watchers|monitoring\s+status)\b/i.test(lower)) {
      return { tool: 'list_dashboard_watchers', args: {} };
    }
    if (/\b(yesterday'?s?\s+alerts|monitoring\s+history|recent\s+alerts|show\s+alerts)\b/i.test(lower)) {
      const since = new Date(Date.now() - 48 * 60 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
      return { tool: 'get_monitoring_history', args: { sinceIso: since, limit: 25 } };
    }
    if (/\b(watch|monitor|check)\b.*\b(dashboard|server|website|endpoint|erp|payment)\b/i.test(lower)) {
      const urlMatch = text.match(/https?:\/\/\S+/i);
      const everyMinMatch = lower.match(/every\s+(\d+)\s*(minute|min|second|sec)/i);
      let intervalMs = 60_000;
      if (everyMinMatch) {
        const num = parseInt(everyMinMatch[1], 10);
        intervalMs = everyMinMatch[2].startsWith('sec') ? num * 1_000 : num * 60_000;
      }
      const nameMatch = text.match(/\b(?:watch|monitor|check)\s+(?:my\s+)?([a-z0-9 _-]+?)(?:\s+every|\s+at|$)/i);
      const name = nameMatch?.[1]?.trim() || 'Default Dashboard';
      return {
        tool: 'start_dashboard_watch',
        args: {
          name,
          targetUrl: urlMatch?.[0] || '',
          intervalMs,
        },
      };
    }

    // Location-triggered reminder: "remind me to X when I reach college"
    const locReminder = text.match(/remind\s+me\s+(?:to\s+)?(.+?)\s+when\s+(?:i|we)\s+(?:reach|arrive\s+at|get\s+to)\s+(.+)/i);
    if (locReminder) {
      return {
        tool: 'create_reminder',
        args: {
          title: locReminder[1].trim(),
          locationName: locReminder[2].replace(/[.!?]+$/, '').trim(),
          triggerOn: 'enter',
        },
      };
    }

    // Alarm: "wake me up at 6 AM tomorrow"
    const alarmMatch = text.match(/wake\s+me\s+up\s+(?:at\s+)?(.+)/i);
    if (alarmMatch) {
      const due = this.parseNaturalTime(alarmMatch[1]);
      if (due) {
        return {
          tool: 'create_alarm',
          args: { title: 'Wake up alarm', dueAt: due.toISOString() },
        };
      }
    }

    // Recurring reminder: "remind me every Monday to check my projects"
    const recurringMatch = text.match(/remind\s+me\s+every\s+(day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:to\s+)?(.+)/i);
    if (recurringMatch) {
      const cadence = recurringMatch[1].toLowerCase() === 'day' ? 'daily' : 'weekly';
      const nextDate = this.parseNextWeekdayOrDaily(recurringMatch[1].toLowerCase());
      return {
        tool: 'create_reminder',
        args: {
          title: recurringMatch[2].replace(/[.!?]+$/, '').trim(),
          dueAt: nextDate.toISOString(),
          recurrence: cadence,
        },
      };
    }

    // One-time reminder: "remind me to submit my assignment at 5 PM"
    const reminderMatch = text.match(/remind\s+me\s+(?:to\s+)?(.+?)\s+(?:at|on|in)\s+(.+)/i);
    if (reminderMatch) {
      const due = this.parseNaturalTime(reminderMatch[2]);
      if (due) {
        return {
          tool: 'create_reminder',
          args: {
            title: reminderMatch[1].trim(),
            dueAt: due.toISOString(),
            recurrence: 'none',
          },
        };
      }
    }

    if (/\b(list|show|what\s+are\s+my)\b.*\b(reminders|alarms)\b/i.test(lower)) {
      return { tool: 'list_reminders', args: {} };
    }

    return null;
  }

  private parseNaturalTime(expr: string): Date | null {
    const clean = expr.replace(/[.!?]+$/, '').trim();
    const now = new Date();

    const inMin = clean.match(/(\d+)\s*(minute|min|hour|hr)s?/i);
    if (inMin) {
      const val = parseInt(inMin[1], 10);
      const ms = inMin[2].toLowerCase().startsWith('h') ? val * 3_600_000 : val * 60_000;
      return new Date(now.getTime() + ms);
    }

    const timeMatch = clean.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const meridiem = timeMatch[3]?.toLowerCase();
      if (meridiem === 'pm' && hours < 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;

      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);
      if (/\btomorrow\b/i.test(clean) || target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1);
      }
      return target;
    }

    const parsed = new Date(clean);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private parseNextWeekdayOrDaily(dayWord: string): Date {
    const now = new Date();
    if (dayWord === 'day') {
      return new Date(now.getTime() + 24 * 3_600_000);
    }
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetIdx = days.indexOf(dayWord);
    const diff = ((targetIdx - now.getDay() + 7) % 7) || 7;
    const target = new Date(now);
    target.setDate(now.getDate() + diff);
    target.setHours(9, 0, 0, 0);
    return target;
  }

  private async finish(
    intentId: string,
    input: string,
    output: string,
    success: boolean,
    executor: TaskResult['executor'],
    risk: RiskLevel,
    startTime: number,
    sessionId?: string,
    actorId = 'local',
    channel: InteractionChannel = 'text'
  ): Promise<TaskResult> {
    const durationMs = Date.now() - startTime;
    const store = await getMemoryStore();
    store.logConversation('assistant', output, undefined, sessionId, actorId, channel);
    store.logTask(intentId, 'assistant', input, output, success, risk, executor, durationMs);
    return {
      id: uuidv4(),
      intentId,
      success,
      output,
      executor,
      durationMs,
      risk,
      approved: true,
      timestamp: new Date().toISOString(),
    };
  }
}

let _brain: AssistantBrain | null = null;
export function getAssistantBrain(): AssistantBrain {
  if (!_brain) {
    _brain = new AssistantBrain();
  }
  return _brain;
}
