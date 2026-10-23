/**
 * Route handlers for projects.
 *
 * GET    /v1/projects                                   - list the tree
 * POST   /v1/projects                                   - create a project
 * PATCH  /v1/projects/:projectId                        - rename a project
 * POST   /v1/projects/:projectId/archive                - archive a project
 * GET    /v1/conversations/:conversationId/projects     - project set
 * PUT    /v1/conversations/:conversationId/projects     - replace the set
 * GET    /v1/schedules/:id/projects                     - project set
 * PUT    /v1/schedules/:id/projects                     - replace the set
 *
 * Projects own no data: the briefing (`refs.yaml`) and the human instructions
 * (`instructions.md`) are files, not endpoints.
 */

import { z } from "zod";

import {
  archiveProject,
  buildProjectTree,
  conversationExists,
  createProject,
  getConversationProjectIds,
  getScheduleProjectIds,
  listProjects,
  type ProjectRow,
  ProjectStoreError,
  type ProjectTreeNode,
  renameProject,
  scheduleExists,
  setConversationProjects,
  setScheduleProjects,
} from "../../persistence/project-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  parentId: z.string().nullable(),
  kind: z.enum(["user", "system", "inbox"]),
  sortPosition: z.number(),
  isArchived: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
});

const projectTreeNodeSchema: z.ZodType<ProjectTreeNode> = z.lazy(() =>
  projectSchema.extend({ children: z.array(projectTreeNodeSchema) }),
);

// The tree schema references itself, so it needs a stable component id; without
// one the OpenAPI generator names the anonymous recursive component __schema0.
z.globalRegistry.add(projectTreeNodeSchema, { id: "ProjectTreeNode" });

const createProjectBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
  parentId: z.string().min(1).nullable().optional(),
});

const renameProjectBodySchema = z.object({
  name: z.string().min(1).max(200),
});

const projectIdSetBodySchema = z.object({
  projectIds: z.array(z.string().min(1)),
});

/** Accept `1`, `true`, `yes` and `on` for a boolean query flag. */
function queryFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function mapStoreError(err: unknown): never {
  if (err instanceof ProjectStoreError) {
    if (err.reason === "not_found") {
      throw new NotFoundError(err.message);
    }
    if (err.reason === "forbidden") {
      throw new ForbiddenError(err.message);
    }
    throw new BadRequestError(err.message);
  }
  throw err;
}

function parseBody<T>(
  schema: z.ZodType<T>,
  body: Record<string, unknown> | undefined,
): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message ?? "Invalid request body",
    );
  }
  return parsed.data;
}

function serializeProject(project: ProjectRow): ProjectRow {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    parentId: project.parentId,
    kind: project.kind,
    sortPosition: project.sortPosition,
    isArchived: project.isArchived,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: project.archivedAt,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleListProjects({ queryParams = {} }: RouteHandlerArgs) {
  const rows = await listProjects({
    includeArchived: queryFlag(queryParams.includeArchived),
    includeSystem: queryFlag(queryParams.includeSystem),
  });
  return { projects: buildProjectTree(rows) };
}

async function handleCreateProject({ body }: RouteHandlerArgs) {
  const input = parseBody(createProjectBodySchema, body);
  try {
    return serializeProject(await createProject(input));
  } catch (err) {
    mapStoreError(err);
  }
}

async function handleRenameProject({
  pathParams = {},
  body,
}: RouteHandlerArgs) {
  const projectId = pathParams.projectId;
  const { name } = parseBody(renameProjectBodySchema, body);
  try {
    const project = await renameProject(projectId, name);
    if (!project) {
      throw new NotFoundError("Project not found");
    }
    return serializeProject(project);
  } catch (err) {
    mapStoreError(err);
  }
}

async function handleArchiveProject({ pathParams = {} }: RouteHandlerArgs) {
  const projectId = pathParams.projectId;
  try {
    const project = await archiveProject(projectId);
    if (!project) {
      throw new NotFoundError("Project not found");
    }
    return serializeProject(project);
  } catch (err) {
    mapStoreError(err);
  }
}

async function handleGetConversationProjects({
  pathParams = {},
}: RouteHandlerArgs) {
  const conversationId = pathParams.conversationId;
  if (!(await conversationExists(conversationId))) {
    throw new NotFoundError("Conversation not found");
  }
  const projectIds = await getConversationProjectIds(conversationId);
  return { projectIds };
}

async function handleSetConversationProjects({
  pathParams = {},
  body,
}: RouteHandlerArgs) {
  const { projectIds } = parseBody(projectIdSetBodySchema, body);
  try {
    return {
      projectIds: await setConversationProjects(
        pathParams.conversationId,
        projectIds,
      ),
    };
  } catch (err) {
    mapStoreError(err);
  }
}

async function handleGetScheduleProjects({
  pathParams = {},
}: RouteHandlerArgs) {
  const scheduleId = pathParams.id;
  if (!(await scheduleExists(scheduleId))) {
    throw new NotFoundError("Schedule not found");
  }
  const projectIds = await getScheduleProjectIds(scheduleId);
  return { projectIds };
}

async function handleSetScheduleProjects({
  pathParams = {},
  body,
}: RouteHandlerArgs) {
  const { projectIds } = parseBody(projectIdSetBodySchema, body);
  try {
    return {
      projectIds: await setScheduleProjects(pathParams.id, projectIds),
    };
  } catch (err) {
    mapStoreError(err);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "projects_list",
    endpoint: "projects",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleListProjects,
    summary: "List projects",
    description:
      "Return the project tree, Inbox included. System bucket projects and archived projects are excluded unless requested.",
    tags: ["projects"],
    queryParams: [
      {
        name: "includeArchived",
        type: "boolean",
        description: "Include archived projects.",
      },
      {
        name: "includeSystem",
        type: "boolean",
        description: "Include the system bucket projects.",
      },
    ],
    responseBody: z.object({ projects: z.array(projectTreeNodeSchema) }),
  },
  {
    operationId: "projects_create",
    endpoint: "projects",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleCreateProject,
    responseStatus: "201",
    summary: "Create project",
    description:
      "Create a user project. The server assigns the id and the sort position.",
    tags: ["projects"],
    requestBody: createProjectBodySchema,
    responseBody: projectSchema,
    additionalResponses: {
      "400": { description: "Invalid name or description" },
      "404": { description: "Parent project not found" },
    },
  },
  {
    operationId: "projects_rename",
    endpoint: "projects/:projectId",
    method: "PATCH",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleRenameProject,
    summary: "Rename project",
    description: "Rename a project. The project id is stable.",
    tags: ["projects"],
    pathParams: [
      {
        name: "projectId",
        type: "string",
        description: "Project ID to rename.",
      },
    ],
    requestBody: renameProjectBodySchema,
    responseBody: projectSchema,
    additionalResponses: {
      "400": { description: "Invalid name" },
      "404": { description: "Project not found" },
    },
  },
  {
    operationId: "projects_archive",
    endpoint: "projects/:projectId/archive",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleArchiveProject,
    summary: "Archive project",
    description:
      "Archive a user project. Inbox and system projects are not archivable.",
    tags: ["projects"],
    pathParams: [
      {
        name: "projectId",
        type: "string",
        description: "Project ID to archive.",
      },
    ],
    responseBody: projectSchema,
    additionalResponses: {
      "403": { description: "Project is not archivable" },
      "404": { description: "Project not found" },
    },
  },
  {
    operationId: "conversation_projects_list",
    endpoint: "conversations/:conversationId/projects",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetConversationProjects,
    summary: "Get conversation projects",
    description: "Return the project set of a conversation.",
    tags: ["conversations", "projects"],
    pathParams: [
      {
        name: "conversationId",
        type: "string",
        description: "Conversation whose project set is read.",
      },
    ],
    responseBody: z.object({ projectIds: z.array(z.string()) }),
  },
  {
    operationId: "conversation_projects_replace",
    endpoint: "conversations/:conversationId/projects",
    method: "PUT",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleSetConversationProjects,
    summary: "Replace conversation projects",
    description:
      "Replace the project set of a conversation. There is no primary project.",
    tags: ["conversations", "projects"],
    pathParams: [
      {
        name: "conversationId",
        type: "string",
        description: "Conversation whose project set is replaced.",
      },
    ],
    requestBody: projectIdSetBodySchema,
    responseBody: z.object({ projectIds: z.array(z.string()) }),
    additionalResponses: {
      "400": { description: "A project in the set is archived" },
      "404": { description: "Conversation or project not found" },
    },
  },
  {
    operationId: "schedule_projects_list",
    endpoint: "schedules/:id/projects",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetScheduleProjects,
    summary: "Get schedule projects",
    description:
      "Return the project set of a schedule. A run of the schedule inherits it.",
    tags: ["schedules", "projects"],
    pathParams: [
      {
        name: "id",
        type: "string",
        description: "Schedule whose project set is read.",
      },
    ],
    responseBody: z.object({ projectIds: z.array(z.string()) }),
    additionalResponses: {
      "404": { description: "Schedule not found" },
    },
  },
  {
    operationId: "schedule_projects_replace",
    endpoint: "schedules/:id/projects",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleSetScheduleProjects,
    summary: "Replace schedule projects",
    description:
      "Replace the project set of a schedule. There is no primary project; an empty set means the schedule belongs to no project and its runs keep no project scope.",
    tags: ["schedules", "projects"],
    pathParams: [
      {
        name: "id",
        type: "string",
        description: "Schedule whose project set is replaced.",
      },
    ],
    requestBody: projectIdSetBodySchema,
    responseBody: z.object({ projectIds: z.array(z.string()) }),
    additionalResponses: {
      "400": { description: "A project in the set is archived" },
      "404": { description: "Schedule or project not found" },
    },
  },
];
