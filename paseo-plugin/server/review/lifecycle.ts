import { ReviewAuthorization } from './authorization.ts';
import { ReviewDispatch } from './dispatch.ts';
import { reviewInfrastructure } from './infrastructure.ts';
import { ReviewMaterials } from './materials.ts';
import { ReviewRecovery } from './recovery.ts';
import { ReviewRequests } from './requests.ts';
import { ReviewSessions } from './sessions.ts';
import { ReviewSettings } from './settings.ts';
import { ReviewTransitions } from './transitions.ts';
export function createReviewLifecycle(infrastructure = reviewInfrastructure) {
    const settings: ReviewSettings = new ReviewSettings({ projects: infrastructure.projects, files: infrastructure.files, identity: infrastructure.identity });
    const authorization: ReviewAuthorization = new ReviewAuthorization({ files: infrastructure.files, backend: infrastructure.backend, projects: infrastructure.projects, storage: infrastructure.storage });
    const sessions: ReviewSessions = new ReviewSessions({ get settings() { return settings; }, storage: infrastructure.storage, projects: infrastructure.projects, files: infrastructure.files, identity: infrastructure.identity, clock: infrastructure.clock });
    const materials: ReviewMaterials = new ReviewMaterials({ get authorization() { return authorization; }, git: infrastructure.git, files: infrastructure.files, storage: infrastructure.storage, clock: infrastructure.clock });
    const dispatch: ReviewDispatch = new ReviewDispatch({ get settings() { return settings; }, get sessions() { return sessions; }, get authorization() { return authorization; }, get recovery() { return recovery; }, get transitions() { return transitions; }, storage: infrastructure.storage, clock: infrastructure.clock, projects: infrastructure.projects, identity: infrastructure.identity });
    const transitions: ReviewTransitions = new ReviewTransitions({ get authorization() { return authorization; }, get settings() { return settings; }, get sessions() { return sessions; }, get materials() { return materials; }, get dispatch() { return dispatch; }, storage: infrastructure.storage, clock: infrastructure.clock, projects: infrastructure.projects });
    const recovery: ReviewRecovery = new ReviewRecovery({ get dispatch() { return dispatch; }, get authorization() { return authorization; }, get transitions() { return transitions; }, storage: infrastructure.storage, identity: infrastructure.identity, clock: infrastructure.clock, projects: infrastructure.projects });
    const requests: ReviewRequests = new ReviewRequests({ get recovery() { return recovery; }, get settings() { return settings; }, get authorization() { return authorization; }, get dispatch() { return dispatch; }, get transitions() { return transitions; }, storage: infrastructure.storage, backend: infrastructure.backend, projects: infrastructure.projects });
    return { settings, authorization, sessions, materials, dispatch, transitions, recovery, requests };
}
