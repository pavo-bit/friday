// ============================================================
// FRIDAY — Model Router & Capability Validation
// Uses OPENROUTER_MODEL as the configured default for all tasks
// ============================================================

import { AIModelCapabilities } from '../providers/AIProvider';
import { AITaskCategory, inferModelCapabilities, loadAIConfig } from '../config/ai.config';

export interface RoutedModelSelection {
  model: string;
  category: AITaskCategory;
  capabilities: AIModelCapabilities;
}

export class ModelRouter {
  /**
   * Select the model and its verified capabilities for a task category.
   * By default, uses OPENROUTER_MODEL uniformly to avoid unnecessary switching.
   */
  selectModel(category: AITaskCategory = 'general', modelOverride?: string): RoutedModelSelection {
    const cfg = loadAIConfig();
    const configured = modelOverride || cfg.taskModels?.[category] || cfg.model;
    return {
      model: configured,
      category,
      capabilities: inferModelCapabilities(configured),
    };
  }
}

let _router: ModelRouter | null = null;
export function getModelRouter(): ModelRouter {
  if (!_router) {
    _router = new ModelRouter();
  }
  return _router;
}
