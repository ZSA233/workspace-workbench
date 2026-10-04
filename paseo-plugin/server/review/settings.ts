import { homedir } from "node:os";
import { dirname,join } from "node:path";
import { reviewGlobalPatchSchema,reviewModelOverrideSchema,reviewPreferencePatchSchema,reviewPreferencesSchema,type ReviewModelOverride,type ReviewPreferencePatch,type ReviewPreferences } from "../../shared/agent-review.ts";
import type { ReviewInfrastructure } from './infrastructure.ts';
import { reviewLifecycleEnabled } from './policy.ts';
import type { StoredGlobalSettings } from './types.ts';
type Dependencies = {
    projects: Pick<ReviewInfrastructure["projects"], "currentProject">;
    files: Pick<ReviewInfrastructure["files"], "readFileSync" | "mkdirSync" | "writeFileSync" | "renameSync">;
    identity: Pick<ReviewInfrastructure["identity"], "randomUUID">;
};
export class ReviewSettings {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    projectConfigRaw(): Record<string, unknown> {
        const project = this.deps.projects.currentProject();
        if (!project)
            throw new Error("project_context_required");
        try {
            const value = JSON.parse(this.deps.files.readFileSync(project.configPath, "utf8")) as unknown;
            return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        }
        catch (error) {
            throw new Error(`project_config_unavailable: ${error instanceof Error ? error.message : "invalid JSON"}`);
        }
    }
    reviewSettingsPath(): string {
        return process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS?.trim()
            || join(homedir(), ".config", "workspace-workbench", "review-settings.json");
    }
    readGlobalSettings(): StoredGlobalSettings {
        try {
            const value = JSON.parse(this.deps.files.readFileSync(this.reviewSettingsPath(), "utf8")) as Partial<StoredGlobalSettings>;
            const defaults = value.defaults && typeof value.defaults === "object" ? value.defaults : {};
            const projects = value.projects && typeof value.projects === "object" ? value.projects : {};
            const agentSession = value.agentSession && typeof value.agentSession === "object" ? value.agentSession : undefined;
            return { version: 1, defaults: reviewGlobalPatchSchema.parse(defaults), projects: Object.fromEntries(Object.entries(projects).flatMap(([key, item]) => {
                    const parsed = reviewModelOverrideSchema.safeParse(item);
                    return parsed.success ? [[key, parsed.data]] : [];
                })), ...(agentSession ? { agentSession } : {}) };
        }
        catch {
            return { version: 1, defaults: {}, projects: {} };
        }
    }
    atomicJson(path: string, value: unknown): void {
        this.deps.files.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}.${this.deps.identity.randomUUID()}.tmp`;
        this.deps.files.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        this.deps.files.renameSync(temporary, path);
    }
    readProjectReview(): ReviewPreferencePatch {
        const raw = this.projectConfigRaw().review;
        const parsed = reviewPreferencePatchSchema.safeParse(raw && typeof raw === "object" ? raw : {});
        if (!parsed.success)
            return {};
        // Automatic lifecycle is a deliberate opt-in. Keep the stored project
        // setting intact, but expose the effective safe mode until the project
        // enables WORKBENCH_ENABLE_REVIEW_LIFECYCLE.
        if (parsed.data.mode === "automatic" && !reviewLifecycleEnabled())
            return { ...parsed.data, mode: "off", autoFix: false };
        return parsed.data;
    }
    preferenceLayers(): {
        project: ReviewPreferencePatch;
        global: Partial<ReviewPreferences>;
        models: ReviewModelOverride;
        effective: ReviewPreferences;
        sources: Record<string, "project" | "global" | "default" | "project-model" | "global-model" | "follow-execution">;
    } {
        const project = this.readProjectReview();
        const globalFile = this.readGlobalSettings();
        const projectPath = this.deps.projects.currentProject()?.configPath || "";
        const global = reviewGlobalPatchSchema.parse(globalFile.defaults);
        const models = reviewModelOverrideSchema.parse(globalFile.projects[projectPath] || {});
        const effective = reviewPreferencesSchema.parse({
            ...global,
            ...project,
            executionModel: models.executionModel !== undefined ? models.executionModel : global.executionModel ?? null,
            reviewerModel: models.reviewerModel !== undefined ? models.reviewerModel : global.reviewerModel ?? null,
        });
        const sources: Record<string, "project" | "global" | "default" | "project-model" | "global-model" | "follow-execution"> = {};
        for (const field of ["mode", "autoFix", "maxRounds", "reviewerRole", "instructions", "reviewerSession", "reviewerTimeoutMs", "repairTimeoutMs", "reviewerTarget"] as const) {
            sources[field] = field in (project as Record<string, unknown>) ? "project" : field in (global as Record<string, unknown>) ? "global" : "default";
        }
        sources.executionModel = models.executionModel !== undefined ? "project-model" : global.executionModel !== undefined ? "global-model" : "follow-execution";
        sources.reviewerModel = models.reviewerModel !== undefined ? "project-model" : global.reviewerModel !== undefined ? "global-model" : "follow-execution";
        return { project, global, models, effective, sources };
    }
    updateProjectReview(patch: ReviewPreferencePatch, resetFields: string[]): void {
        const project = this.deps.projects.currentProject();
        if (!project)
            throw new Error("project_context_required");
        const raw = this.projectConfigRaw();
        const previous = raw.review && typeof raw.review === "object" && !Array.isArray(raw.review) ? raw.review as Record<string, unknown> : {};
        const next = { ...previous, ...patch };
        for (const field of resetFields)
            delete (next as Record<string, unknown>)[field];
        if (Object.keys(next).length)
            raw.review = next;
        else
            delete raw.review;
        this.atomicJson(project.configPath, raw);
    }
    updateReviewSettings(scope: "project" | "global" | "project-model", patch: ReviewPreferencePatch | ReviewModelOverride, resetFields: string[]): void {
        if (scope === "project") {
            this.updateProjectReview(reviewPreferencePatchSchema.parse(patch), resetFields);
            return;
        }
        const file = this.readGlobalSettings();
        if (scope === "project-model") {
            const projectPath = this.deps.projects.currentProject()?.configPath;
            if (!projectPath)
                throw new Error("project_context_required");
            const current = file.projects[projectPath] || {};
            const next = { ...current, ...reviewModelOverrideSchema.parse(patch) };
            for (const field of resetFields)
                delete (next as Record<string, unknown>)[field];
            if (Object.keys(next).length)
                file.projects[projectPath] = next;
            else
                delete file.projects[projectPath];
        }
        else {
            const parsed = reviewGlobalPatchSchema.parse(patch);
            file.defaults = { ...file.defaults, ...parsed };
            for (const field of resetFields)
                delete (file.defaults as Record<string, unknown>)[field];
        }
        this.atomicJson(this.reviewSettingsPath(), file);
    }
    getReviewSettings(): ReturnType<ReviewSettings["preferenceLayers"]> {
        return this.preferenceLayers();
    }
    configuredExecutionModel(): string | null {
        try {
            return this.preferenceLayers().effective.executionModel;
        }
        catch (error) {
            if (error instanceof Error && error.message === "project_context_required")
                return null;
            throw error;
        }
    }
}
