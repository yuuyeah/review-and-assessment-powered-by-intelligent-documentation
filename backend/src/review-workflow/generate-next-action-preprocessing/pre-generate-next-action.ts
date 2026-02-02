/**
 * Pre-Generate Next Action Handler
 *
 * Prepares data for the Strands Agent that generates next actions.
 * This step:
 * - Checks if Next Action generation is enabled
 * - Retrieves the prompt template (or uses default)
 * - Retrieves the tool configuration if specified
 * - Gathers review results and formats template data
 */

import { getPrismaClient } from "../../api/core/db";
import { NEXT_ACTION_STATUS } from "../../api/features/review/domain/model/review";
import { makePrismaToolConfigurationRepository } from "../../api/features/tool-configuration/domain/repository";

declare const console: {
  log: (...data: any[]) => void;
  error: (...data: any[]) => void;
};

/** Default prompt for Next Action generation */
const DEFAULT_NEXT_ACTION_PROMPT = `
You are an AI assistant that generates concise, actionable next steps based on document review results.

## Review Results
{{all_results}}

## Output Format
Generate a markdown-formatted response. For each failed item, output in this format:

1. **[Check item name]**
   - Location: [filename, page number]
   - Action: [Concrete action to take]

## Guidelines
- Use heading level 3 (###) or lower - never use h1 or h2
- Be concise - one item per failed check
- Specify the exact location (filename, page number)
- Provide concrete action, not general advice
- Do NOT include general improvement suggestions
- Do NOT include warnings or disclaimers
- IMPORTANT: Output ENTIRELY in the same language as the input document
`;

export interface PreGenerateNextActionParams {
  reviewJobId: string;
  userId?: string;
}

interface TemplateData {
  allResults: EnrichedReviewResult[];
}

interface EnrichedReviewResult {
  checkList: {
    name: string;
    description: string | null;
    parentName: string | null;
  };
  result: string | null;
  userOverride: boolean;
  explanation: string | null;
  extractedText: string | null;
  confidenceScore: number | null;
  userComment: string | null;
  sourceReferences: SourceReference[];
}

interface SourceReference {
  filename: string;
  pageNumber: number | null;
}

interface ToolConfigurationOutput {
  id: string;
  name: string;
  knowledgeBase?: KnowledgeBaseConfig[];
  codeInterpreter?: boolean;
  mcpConfig?: {
    mcpServers: McpServerConfig[];
  };
}

interface KnowledgeBaseConfig {
  knowledgeBaseId: string;
  description?: string;
}

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface PreGenerateNextActionResult {
  shouldGenerate: boolean;
  promptTemplate?: {
    prompt: string;
  };
  templateData?: TemplateData;
  toolConfiguration?: ToolConfigurationOutput;
  message?: string;
}

export async function preGenerateNextAction(
  params: PreGenerateNextActionParams
): Promise<PreGenerateNextActionResult> {
  const { reviewJobId } = params;
  console.log(
    `[PreGenerateNextAction] Starting for reviewJobId: ${reviewJobId}`
  );

  const db = await getPrismaClient();

  // 1. Get ReviewJob with CheckListSet
  const reviewJob = await db.reviewJob.findUnique({
    where: { id: reviewJobId },
    include: {
      checkListSet: true,
      documents: {
        select: {
          id: true,
          filename: true,
        },
      },
    },
  });

  if (!reviewJob) {
    console.error(
      `[PreGenerateNextAction] ReviewJob not found: ${reviewJobId}`
    );
    return {
      shouldGenerate: false,
      message: "Review job not found",
    };
  }

  // 2. Check if Next Action is enabled
  const enableNextAction = reviewJob.checkListSet.enableNextAction;
  const nextActionTemplateId = reviewJob.checkListSet.nextActionTemplateId;

  if (!enableNextAction) {
    console.log(`[PreGenerateNextAction] Next Action is disabled, skipping`);

    // Update status to skipped
    await db.reviewJob.update({
      where: { id: reviewJobId },
      data: {
        nextActionStatus: NEXT_ACTION_STATUS.SKIPPED,
        updatedAt: new Date(),
      },
    });

    return {
      shouldGenerate: false,
      message: "Next Action is disabled",
    };
  }

  // 3. Set status to processing
  await db.reviewJob.update({
    where: { id: reviewJobId },
    data: {
      nextActionStatus: NEXT_ACTION_STATUS.PROCESSING,
      updatedAt: new Date(),
    },
  });

  // 4. Get prompt template (use default if not specified)
  let promptToUse: string = DEFAULT_NEXT_ACTION_PROMPT;
  let toolConfigurationId: string | undefined;

  if (nextActionTemplateId) {
    const template = await db.promptTemplate.findUnique({
      where: { id: nextActionTemplateId },
    });

    if (!template) {
      console.error(
        `[PreGenerateNextAction] Template not found: ${nextActionTemplateId}`
      );

      await db.reviewJob.update({
        where: { id: reviewJobId },
        data: {
          nextActionStatus: NEXT_ACTION_STATUS.FAILED,
          updatedAt: new Date(),
        },
      });

      return {
        shouldGenerate: false,
        message: "Prompt template not found",
      };
    }

    promptToUse = template.prompt;
    toolConfigurationId = template.toolConfigurationId ?? undefined;
    console.log(
      `[PreGenerateNextAction] Using custom template: ${nextActionTemplateId}`
    );
  } else {
    console.log(`[PreGenerateNextAction] Using default prompt`);
  }

  // 5. Get review results with parent hierarchy
  const reviewResults = await db.reviewResult.findMany({
    where: { reviewJobId },
    include: {
      checkList: {
        select: {
          id: true,
          name: true,
          description: true,
          parent: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  });

  // 6. Prepare template variable data
  // Create documentId -> filename map for sourceReferences resolution
  const documentMap = new Map(
    reviewJob.documents.map((doc) => [doc.id, doc.filename])
  );

  // Resolve sourceReferences documentId to filename
  const resolveSourceReferences = (
    refs: unknown
  ): SourceReference[] => {
    if (!refs) return [];

    // Handle JSON string
    let parsed = refs;
    if (typeof refs === "string") {
      try {
        parsed = JSON.parse(refs);
      } catch {
        return [];
      }
    }

    // Ensure it's an array
    if (!Array.isArray(parsed)) return [];

    return parsed.map((ref: { documentId?: string; pageNumber?: number | null }) => ({
      filename: ref.documentId ? (documentMap.get(ref.documentId) || "Unknown") : "Unknown",
      pageNumber: ref.pageNumber ?? null,
    }));
  };

  const templateData: TemplateData = {
    allResults: reviewResults.map((item) => ({
      checkList: {
        name: item.checkList.name,
        description: item.checkList.description,
        parentName: item.checkList.parent?.name ?? null,
      },
      result: item.result,
      userOverride: item.userOverride,
      explanation: item.explanation,
      extractedText: item.extractedText,
      confidenceScore: item.confidenceScore,
      userComment: item.userComment,
      sourceReferences: resolveSourceReferences(item.sourceReferences),
    })),
  };

  const passCount = reviewResults.filter((r) => r.result === "pass").length;
  const failCount = reviewResults.filter((r) => r.result === "fail").length;

  // 7. Get tool configuration if specified
  let toolConfiguration: ToolConfigurationOutput | undefined;
  if (toolConfigurationId) {
    const toolConfigRepo = await makePrismaToolConfigurationRepository();
    try {
      const config = await toolConfigRepo.findById(toolConfigurationId);

      // Transform to agent-compatible format
      toolConfiguration = {
        id: config.id,
        name: config.name,
      };

      // Add knowledge bases if configured
      if (config.knowledgeBase?.length) {
        toolConfiguration.knowledgeBase = config.knowledgeBase;
      }

      // Add code interpreter if enabled
      if (config.codeInterpreter) {
        toolConfiguration.codeInterpreter = true;
      }

      // Add MCP servers if configured
      if (config.mcpConfig?.mcpServers?.length) {
        toolConfiguration.mcpConfig = config.mcpConfig;
      }

      console.log(
        `[PreGenerateNextAction] Using tool configuration: ${toolConfigurationId}`
      );
    } catch (error) {
      console.error(
        `[PreGenerateNextAction] Failed to fetch tool configuration: ${error}`
      );
      // Continue without tool configuration
    }
  }

  console.log(
    `[PreGenerateNextAction] Prepared data: ${passCount} pass, ${failCount} fail, ${templateData.allResults.length} total items`
  );

  return {
    shouldGenerate: true,
    promptTemplate: {
      prompt: promptToUse,
    },
    templateData,
    toolConfiguration,
  };
}
