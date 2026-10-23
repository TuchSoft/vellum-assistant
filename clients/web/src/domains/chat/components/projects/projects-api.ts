/**
 * Projects: the daemon routes, typed and validated.
 *
 * The routes are part of the generated daemon SDK (`GET /v1/projects`,
 * `POST /v1/projects`, `PATCH /v1/projects/:projectId`,
 * `POST /v1/projects/:projectId/archive`, and the conversation membership
 * pair under `/v1/conversations/:conversationId/projects`), so the request
 * shapes come from codegen. The responses still cross a network boundary, so
 * every payload is parsed with Zod before the UI reads a field.
 *
 * Writes are never optimistic: the caller invalidates and refetches, so the
 * tree and the membership checkboxes always show what the store holds.
 */

import { z } from "zod";

import {
  conversationsByConversationIdProjectsGet,
  conversationsByConversationIdProjectsPut,
  projectsByProjectIdArchivePost,
  projectsByProjectIdPatch,
  projectsGet,
  projectsPost,
} from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export const PROJECT_KINDS = ["user", "system", "inbox"] as const;

export type ProjectKind = (typeof PROJECT_KINDS)[number];

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  parentId: z.string().nullable(),
  kind: z.enum(PROJECT_KINDS),
  sortPosition: z.number(),
  isArchived: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
});

export type Project = z.infer<typeof ProjectSchema>;

export interface ProjectNode extends Project {
  children: ProjectNode[];
}

const ProjectNodeSchema: z.ZodType<ProjectNode> = z.lazy(() =>
  ProjectSchema.extend({ children: z.array(ProjectNodeSchema) }),
);

const ProjectTreeSchema = z.object({ projects: z.array(ProjectNodeSchema) });

const ConversationProjectsSchema = z.object({
  projectIds: z.array(z.string()),
});

function fail(
  response: Response,
  error: unknown,
  fallback: string,
): never {
  throw new ApiError(
    response.status,
    extractErrorMessage(error, response, fallback),
  );
}

export async function fetchProjects(
  assistantId: string,
  options: { includeArchived?: boolean } = {},
): Promise<ProjectNode[]> {
  const { data, error, response } = await projectsGet({
    path: { assistant_id: assistantId },
    query: { includeArchived: options.includeArchived === true },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load projects.");
  if (!response.ok) {
    fail(response, error, "Failed to load projects.");
  }
  const parsed = ProjectTreeSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      "The assistant returned an unreadable project tree.",
    );
  }
  return parsed.data.projects;
}

export interface CreateProjectInput {
  name: string;
  parentId?: string | null;
}

export async function createProject(
  assistantId: string,
  input: CreateProjectInput,
): Promise<Project> {
  const { data, error, response } = await projectsPost({
    path: { assistant_id: assistantId },
    body: {
      name: input.name,
      parentId: input.parentId ?? null,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to create the project.");
  if (!response.ok) {
    fail(response, error, "Failed to create the project.");
  }
  const parsed = ProjectSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      "The assistant returned an unreadable project.",
    );
  }
  return parsed.data;
}

export async function renameProject(
  assistantId: string,
  projectId: string,
  name: string,
): Promise<Project> {
  const { data, error, response } = await projectsByProjectIdPatch({
    path: { assistant_id: assistantId, projectId },
    body: { name },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to rename the project.");
  if (!response.ok) {
    fail(response, error, "Failed to rename the project.");
  }
  const parsed = ProjectSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      "The assistant returned an unreadable project.",
    );
  }
  return parsed.data;
}

export async function archiveProject(
  assistantId: string,
  projectId: string,
): Promise<Project> {
  const { data, error, response } = await projectsByProjectIdArchivePost({
    path: { assistant_id: assistantId, projectId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to archive the project.");
  if (!response.ok) {
    fail(response, error, "Failed to archive the project.");
  }
  const parsed = ProjectSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      "The assistant returned an unreadable project.",
    );
  }
  return parsed.data;
}

/** The project set of one conversation. There is no bulk read. */
export async function fetchConversationProjects(
  assistantId: string,
  conversationId: string,
): Promise<string[]> {
  const { data, error, response } =
    await conversationsByConversationIdProjectsGet({
      path: { assistant_id: assistantId, conversationId },
      throwOnError: false,
    });
  assertHasResponse(response, error, "Failed to load the conversation projects.");
  if (!response.ok) {
    fail(response, error, "Failed to load the conversation projects.");
  }
  const parsed = ConversationProjectsSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      "The assistant returned an unreadable project set.",
    );
  }
  return parsed.data.projectIds;
}

/** Replace a conversation's project set. There is no primary project. */
export async function replaceConversationProjects(
  assistantId: string,
  conversationId: string,
  projectIds: readonly string[],
): Promise<string[]> {
  const { data, error, response } =
    await conversationsByConversationIdProjectsPut({
      path: { assistant_id: assistantId, conversationId },
      body: { projectIds: [...projectIds] },
      throwOnError: false,
    });
  assertHasResponse(
    response,
    error,
    "Failed to update the conversation projects.",
  );
  if (!response.ok) {
    fail(response, error, "Failed to update the conversation projects.");
  }
  const parsed = ConversationProjectsSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      "The assistant returned an unreadable project set.",
    );
  }
  return parsed.data.projectIds;
}
