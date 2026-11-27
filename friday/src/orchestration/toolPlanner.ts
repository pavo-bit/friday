// ============================================================
// FRIDAY — Structured Multi-Tool Planner & Deterministic Validator
// Constructs DAG execution plans; validates capabilities, schemas,
// cycles, dependencies, permissions, and SafetyGate rules.
// Never executes tools directly.
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import {
  CapabilityRegistry,
  CapabilityRiskLevel,
  CapabilitySchema,
  getCapabilityRegistry,
} from './toolRegistry';
import { DiscoveryResult } from './capabilityDiscovery';
import { getConfig } from '../shared/config';

export type StepFailureBehaviour = 'abort' | 'continue' | 'retry';

export interface ExecutionPlanStep {
  stepId: string;
  capabilityId: string;
  capabilityName: string;
  arguments: Record<string, unknown>;
  dependencies: string[];
  executionOrder: number;
  timeoutMs: number;
  expectedOutput: CapabilitySchema;
  failureBehaviour: StepFailureBehaviour;
  riskLevel: CapabilityRiskLevel;
  requiresApproval: boolean;
  requiredPermissions: string[];
}

export interface PlanMissingInput {
  stepId: string;
  capabilityId: string;
  fields: string[];
  clarificationQuestion: string;
}

export interface ExecutionPlan {
  planId: string;
  conversationId?: string;
  originalRequest: string;
  normalizedIntent: string;
  steps: ExecutionPlanStep[];
  dependencies: Record<string, string[]>;
  parallelGroups: string[][];
  requiredInputs: Record<string, unknown>;
  missingInputs: PlanMissingInput[];
  requiredPermissions: string[];
  riskClassifications: Record<string, CapabilityRiskLevel>;
  approvalRequirements: {
    required: boolean;
    stepIds: string[];
    reason?: string;
  };
  expectedOutputs: Record<string, CapabilitySchema>;
  failurePolicy: 'fail_fast' | 'best_effort';
  valid: boolean;
  validationErrors: string[];
  clarificationNeeded?: string;
  createdAt: string;
}

export interface ProposedPlanStepInput {
  stepId: string;
  capabilityId: string;
  arguments?: Record<string, unknown>;
  dependencies?: string[];
  failureBehaviour?: StepFailureBehaviour;
  // Untrusted fields (e.g. if proposed by LLM) — ignored by deterministic validator:
  permissions?: string[];
  riskLevel?: string;
}

export interface PlannerOptions {
  conversationId?: string;
  userPermissions?: readonly string[];
  failurePolicy?: 'fail_fast' | 'best_effort';
}

export class ToolPlanner {
  constructor(private readonly registry: CapabilityRegistry = getCapabilityRegistry()) {}

  /**
   * Build and deterministically validate an ExecutionPlan from DiscoveryResult.
   */
  async createPlan(
    discovery: DiscoveryResult,
    options: PlannerOptions = {}
  ): Promise<ExecutionPlan> {
    const planId = uuidv4();
    const createdAt = new Date().toISOString();
    const validationErrors: string[] = [];

    if (discovery.unavailable.length > 0 && discovery.matched.length === 0) {
      return this.buildInvalidPlan(
        planId,
        discovery.request,
        discovery.normalizedIntent,
        createdAt,
        options,
        discovery.unavailable.map((u) => `Capability "${u.name}" is unavailable: ${u.reason}`),
        discovery.clarificationNeeded
      );
    }

    const capToStepId = new Map<string, string>();
    const rawSteps: ProposedPlanStepInput[] = discovery.matched.map((item, idx) => {
      const stepId = `step_${idx + 1}`;
      capToStepId.set(item.capability.id, stepId);
      return {
        stepId,
        capabilityId: item.capability.id,
        arguments: item.suggestedArguments,
        dependencies: [],
        failureBehaviour: 'abort',
      };
    });

    // Resolve capability-level dependencies into stepId dependencies
    for (let i = 0; i < discovery.matched.length; i++) {
      const deps = discovery.matched[i].dependsOn || [];
      for (const depCapId of deps) {
        const depStepId = capToStepId.get(depCapId);
        if (depStepId) {
          rawSteps[i].dependencies!.push(depStepId);
        } else {
          validationErrors.push(
            `Capability "${discovery.matched[i].capability.id}" depends on missing capability "${depCapId}".`
          );
        }
      }
    }

    const missingInputs: PlanMissingInput[] = discovery.missingInputs.map((m) => ({
      stepId: capToStepId.get(m.capabilityId) || 'step_unknown',
      capabilityId: m.capabilityId,
      fields: m.fields,
      clarificationQuestion: m.clarificationQuestion,
    }));

    const validated = await this.validateProposedSteps(
      {
        planId,
        originalRequest: discovery.request,
        normalizedIntent: discovery.normalizedIntent,
        steps: rawSteps,
        missingInputs,
        clarificationNeeded: discovery.clarificationNeeded,
        extraErrors: validationErrors,
      },
      options
    );

    return validated;
  }

  /**
   * Deterministically validate an externally proposed (e.g. LLM-proposed) plan.
   * Never trusts model-supplied permissions, risk classifications, or unregistered capabilities.
   */
  async validateProposedPlan(
    params: {
      originalRequest: string;
      normalizedIntent?: string;
      steps: ProposedPlanStepInput[];
      parallelGroups?: string[][];
    },
    options: PlannerOptions = {}
  ): Promise<ExecutionPlan> {
    return this.validateProposedSteps(
      {
        planId: uuidv4(),
        originalRequest: params.originalRequest,
        normalizedIntent: params.normalizedIntent || params.originalRequest,
        steps: params.steps,
        explicitParallelGroups: params.parallelGroups,
      },
      options
    );
  }

  private async validateProposedSteps(
    input: {
      planId: string;
      originalRequest: string;
      normalizedIntent: string;
      steps: ProposedPlanStepInput[];
      explicitParallelGroups?: string[][];
      missingInputs?: PlanMissingInput[];
      clarificationNeeded?: string;
      extraErrors?: string[];
    },
    options: PlannerOptions
  ): Promise<ExecutionPlan> {
    const errors: string[] = [...(input.extraErrors || [])];
    const config = getConfig();
    const stepMap = new Map<string, ProposedPlanStepInput>();

    for (const s of input.steps) {
      if (!s.stepId) {
        errors.push('Every plan step must have a stepId.');
        continue;
      }
      if (stepMap.has(s.stepId)) {
        errors.push(`Duplicate stepId "${s.stepId}".`);
        continue;
      }
      stepMap.set(s.stepId, s);
    }

    // 1. Validate capabilities, availability, permissions, and arguments
    const builtSteps: ExecutionPlanStep[] = [];
    const requiredPermissionsSet = new Set<string>();
    const riskClassifications: Record<string, CapabilityRiskLevel> = {};
    const expectedOutputs: Record<string, CapabilitySchema> = {};
    const requiredInputs: Record<string, unknown> = {};
    const approvalStepIds: string[] = [];
    const missingInputs: PlanMissingInput[] = [...(input.missingInputs || [])];

    for (const rawStep of input.steps) {
      const cap = this.registry.get(rawStep.capabilityId);
      if (!cap) {
        errors.push(`Unregistered capability "${rawStep.capabilityId}" in step "${rawStep.stepId}".`);
        continue;
      }
      if (!cap.enabled) {
        errors.push(`Capability "${cap.id}" in step "${rawStep.stepId}" is disabled.`);
      }

      try {
        const avail = await cap.isAvailable();
        if (!avail.available) {
          errors.push(`Capability "${cap.id}" is unavailable: ${avail.reason || 'unavailable'}.`);
        }
      } catch (err) {
        errors.push(`Capability "${cap.id}" availability check failed: ${(err as Error).message}`);
      }

      // Check dependencies exist
      const deps = rawStep.dependencies || [];
      for (const depId of deps) {
        if (depId === rawStep.stepId) {
          errors.push(`Step "${rawStep.stepId}" cannot depend on itself.`);
        } else if (!stepMap.has(depId)) {
          errors.push(`Step "${rawStep.stepId}" depends on unknown step "${depId}".`);
        }
      }

      // Validate input arguments against capability schema
      const args = rawStep.arguments || {};
      const argValidation = cap.validate(args);
      if (!argValidation.valid) {
        errors.push(
          `Invalid arguments for "${cap.id}" (${rawStep.stepId}): ${argValidation.errors.join(' ')}`
        );
      }

      // Permission check against actual user context (never trust LLM-supplied permissions)
      if (options.userPermissions) {
        const missingPerms = cap.permissions.filter((p) => !options.userPermissions!.includes(p));
        if (missingPerms.length > 0) {
          errors.push(
            `Permission denied for "${cap.id}" (${rawStep.stepId}). Missing: ${missingPerms.join(', ')}`
          );
        }
      }

      for (const p of cap.permissions) requiredPermissionsSet.add(p);
      riskClassifications[rawStep.stepId] = cap.riskLevel;
      expectedOutputs[rawStep.stepId] = cap.outputSchema;
      requiredInputs[rawStep.stepId] = args;

      const requiresApproval = cap.riskLevel === 'high' && config.requireHighRiskApproval;
      if (requiresApproval) approvalStepIds.push(rawStep.stepId);

      builtSteps.push({
        stepId: rawStep.stepId,
        capabilityId: cap.id,
        capabilityName: cap.name,
        arguments: args,
        dependencies: [...deps],
        executionOrder: 0,
        timeoutMs: cap.timeoutMs,
        expectedOutput: cap.outputSchema,
        failureBehaviour: rawStep.failureBehaviour || 'abort',
        riskLevel: cap.riskLevel,
        requiresApproval,
        requiredPermissions: [...cap.permissions],
      });
    }

    // 2. Topological sort & cycle detection (Kahn's algorithm)
    const { parallelGroups, stepLevels, hasCycle } = this.computeDagLayers(builtSteps);
    if (hasCycle) {
      errors.push('Cyclic dependency detected in execution plan.');
    } else {
      for (const step of builtSteps) {
        step.executionOrder = stepLevels.get(step.stepId) ?? 0;
      }
      builtSteps.sort((a, b) => a.executionOrder - b.executionOrder);
    }

    // 3. Validate explicit parallelGroups if caller provided them
    if (input.explicitParallelGroups && !hasCycle) {
      const builtMap = new Map(builtSteps.map((s) => [s.stepId, s]));
      for (const group of input.explicitParallelGroups) {
        const groupSet = new Set(group);
        for (const sid of group) {
          const st = builtMap.get(sid);
          if (!st) continue;
          for (const dep of st.dependencies) {
            if (groupSet.has(dep)) {
              errors.push(`Parallel group violation: "${sid}" depends on "${dep}" in the same group.`);
            }
          }
        }
      }
    }

    const dependenciesMap: Record<string, string[]> = {};
    for (const s of builtSteps) {
      dependenciesMap[s.stepId] = s.dependencies;
    }

    return {
      planId: input.planId,
      conversationId: options.conversationId,
      originalRequest: input.originalRequest,
      normalizedIntent: input.normalizedIntent,
      steps: builtSteps,
      dependencies: dependenciesMap,
      parallelGroups,
      requiredInputs,
      missingInputs,
      requiredPermissions: Array.from(requiredPermissionsSet),
      riskClassifications,
      approvalRequirements: {
        required: approvalStepIds.length > 0,
        stepIds: approvalStepIds,
        reason:
          approvalStepIds.length > 0
            ? `High-risk steps require explicit approval: ${approvalStepIds.join(', ')}`
            : undefined,
      },
      expectedOutputs,
      failurePolicy: options.failurePolicy || 'fail_fast',
      valid: errors.length === 0 && missingInputs.length === 0,
      validationErrors: errors,
      clarificationNeeded: input.clarificationNeeded,
      createdAt: new Date().toISOString(),
    };
  }

  private computeDagLayers(steps: ExecutionPlanStep[]): {
    parallelGroups: string[][];
    stepLevels: Map<string, number>;
    hasCycle: boolean;
  } {
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    const validIds = new Set(steps.map((s) => s.stepId));

    for (const s of steps) {
      const validDeps = s.dependencies.filter((d) => validIds.has(d) && d !== s.stepId);
      inDegree.set(s.stepId, validDeps.length);
      for (const dep of validDeps) {
        const arr = dependents.get(dep) || [];
        arr.push(s.stepId);
        dependents.set(dep, arr);
      }
    }

    const parallelGroups: string[][] = [];
    const stepLevels = new Map<string, number>();
    let currentLayer = steps.filter((s) => (inDegree.get(s.stepId) ?? 0) === 0).map((s) => s.stepId);
    let level = 0;
    let processed = 0;

    while (currentLayer.length > 0) {
      parallelGroups.push(currentLayer);
      const nextLayer: string[] = [];

      for (const sid of currentLayer) {
        stepLevels.set(sid, level);
        processed++;
        for (const depId of dependents.get(sid) || []) {
          const nextDeg = (inDegree.get(depId) ?? 1) - 1;
          inDegree.set(depId, nextDeg);
          if (nextDeg === 0) {
            nextLayer.push(depId);
          }
        }
      }

      currentLayer = nextLayer;
      level++;
    }

    return {
      parallelGroups,
      stepLevels,
      hasCycle: processed !== steps.length,
    };
  }

  private buildInvalidPlan(
    planId: string,
    originalRequest: string,
    normalizedIntent: string,
    createdAt: string,
    options: PlannerOptions,
    validationErrors: string[],
    clarificationNeeded?: string
  ): ExecutionPlan {
    return {
      planId,
      conversationId: options.conversationId,
      originalRequest,
      normalizedIntent,
      steps: [],
      dependencies: {},
      parallelGroups: [],
      requiredInputs: {},
      missingInputs: [],
      requiredPermissions: [],
      riskClassifications: {},
      approvalRequirements: { required: false, stepIds: [] },
      expectedOutputs: {},
      failurePolicy: options.failurePolicy || 'fail_fast',
      valid: false,
      validationErrors,
      clarificationNeeded,
      createdAt,
    };
  }
}

let _planner: ToolPlanner | null = null;
export function getToolPlanner(): ToolPlanner {
  if (!_planner) {
    _planner = new ToolPlanner();
  }
  return _planner;
}
