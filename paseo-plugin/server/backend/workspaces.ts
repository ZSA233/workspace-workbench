import { WorkspaceScope } from './workspace-scope.ts';
import type { Config } from './config.ts';
import { ObservationRecords } from './observation-records.ts';
import { SerialQueue } from './storage.ts';
import { WorkspaceActivity } from './workspace-activity-guard.ts';
import { WorkspaceCatalog } from './workspace-catalog.ts';
import { WorkspaceCreation } from './workspace-creation.ts';
import { WorkspaceDeletion } from './workspace-deletion.ts';
import { WorkspaceDirectory } from './workspace-directory.ts';
import { workspaceInfrastructure } from './workspace-infrastructure.ts';
import { WorkspaceRecords } from './workspace-records.ts';
import { WorkspaceRemoval } from './workspace-removal.ts';
/** Public lifecycle API; domain owners never import this assembly module. */
export class Workspaces {
    config: Config;
    preparationActive: (id: string) => boolean = () => false;
    onOrphanScanChanged?: () => void;
    onDiscoveryChanged?: () => void;
    readonly mutations = new SerialQueue();
    readonly observationRecords = new ObservationRecords(() => this.config, () => this.onOrphanScanChanged?.());
    readonly records: WorkspaceRecords;
    readonly catalog: WorkspaceCatalog;
    readonly directory: WorkspaceDirectory;
    readonly activity: WorkspaceActivity;
    readonly creation: WorkspaceCreation;
    readonly scope: WorkspaceScope;
    readonly removal: WorkspaceRemoval;
    readonly deletion: WorkspaceDeletion;
    constructor(config: Config, infrastructure = workspaceInfrastructure) {
        this.config = config;
        for (const root of [config.stateRoot, config.workspaceRoot, config.recordsRoot, config.treesRoot])
            infrastructure.files.mkdirSync(root, { recursive: true, mode: 0o700 });
        this.records = new WorkspaceRecords({ ...infrastructure, config: () => this.config });
        this.catalog = new WorkspaceCatalog({ ...infrastructure, config: () => this.config, onDiscoveryChanged: () => this.onDiscoveryChanged?.(), records: this.records, onOrphanScanChanged: () => this.onOrphanScanChanged?.() });
        this.directory = new WorkspaceDirectory({ ...infrastructure, config: () => this.config, catalog: this.catalog, records: this.records });
        this.activity = new WorkspaceActivity({ ...infrastructure, preparationActive: id => this.preparationActive(id), config: () => this.config });
        this.creation = new WorkspaceCreation({ ...infrastructure, records: this.records, config: () => this.config, catalog: this.catalog, directory: this.directory });
        this.scope = new WorkspaceScope({ creation: this.creation, records: this.records, directory: this.directory, activity: this.activity });
        this.removal = new WorkspaceRemoval({ ...infrastructure, directory: this.directory, records: this.records });
        this.deletion = new WorkspaceDeletion({ ...infrastructure, config: () => this.config, records: this.records, activity: this.activity, directory: this.directory });
    }
    capabilities = (...args: Parameters<WorkspaceDirectory["capabilities"]>) => this.directory.capabilities(...args);
    linkedCandidates = (...args: Parameters<WorkspaceCatalog["linkedCandidates"]>) => this.catalog.linkedCandidates(...args);
    saveLinkedSelection = (...args: Parameters<WorkspaceCatalog["saveLinkedSelection"]>) => this.catalog.saveLinkedSelection(...args);
    refreshLinked = (...args: Parameters<WorkspaceCatalog["refreshLinked"]>) => this.catalog.refreshLinked(...args);
    previewGitlink = (...args: Parameters<WorkspaceDirectory["previewGitlink"]>) => this.directory.previewGitlink(...args);
    mainCandidates = (...args: Parameters<WorkspaceCatalog["mainCandidates"]>) => this.catalog.mainCandidates(...args);
    discoverySnapshot = (...args: Parameters<WorkspaceCatalog["discoverySnapshot"]>) => this.catalog.discoverySnapshot(...args);
    saveMainSelection = (...args: Parameters<WorkspaceCatalog["saveMainSelection"]>) => this.catalog.saveMainSelection(...args);
    orphanSnapshot = (...args: Parameters<WorkspaceCatalog["orphanSnapshot"]>) => this.catalog.orphanSnapshot(...args);
    invalidateOrphanScan = (...args: Parameters<WorkspaceCatalog["invalidateOrphanScan"]>) => this.catalog.invalidateOrphanScan(...args);
    orphanCandidates = (...args: Parameters<WorkspaceCatalog["orphanCandidates"]>) => this.catalog.orphanCandidates(...args);
    observationSupplementSnapshot = (...args: Parameters<WorkspaceCatalog["observationSupplementSnapshot"]>) => this.catalog.observationSupplementSnapshot(...args);
    orphanPreview = (...args: Parameters<WorkspaceCatalog["orphanPreview"]>) => this.catalog.orphanPreview(...args);
    adoptOrphan = (...args: Parameters<WorkspaceCreation["adoptOrphan"]>) => this.creation.adoptOrphan(...args);
    recordReadHealth = (...args: Parameters<WorkspaceDirectory["recordReadHealth"]>) => this.directory.recordReadHealth(...args);
    roster = (...args: Parameters<WorkspaceDirectory["roster"]>) => this.directory.roster(...args);
    list = (...args: Parameters<WorkspaceDirectory["list"]>) => this.directory.list(...args);
    get = (...args: Parameters<WorkspaceDirectory["get"]>) => this.directory.get(...args);
    repository = (...args: Parameters<WorkspaceRecords["repository"]>) => this.records.repository(...args);
    create = (...args: Parameters<WorkspaceCreation["create"]>) => this.creation.create(...args);
    operationStatus = (...args: Parameters<WorkspaceDirectory["operationStatus"]>) => this.directory.operationStatus(...args);
    add = (...args: Parameters<WorkspaceScope["add"]>) => this.scope.add(...args);
    impact = (...args: Parameters<WorkspaceDeletion["impact"]>) => this.deletion.impact(...args);
    remove = (...args: Parameters<WorkspaceRemoval["remove"]>) => this.removal.remove(...args);
    restore = (...args: Parameters<WorkspaceRemoval["restore"]>) => this.removal.restore(...args);
    cleanup = (...args: Parameters<WorkspaceDeletion["cleanup"]>) => this.deletion.cleanup(...args);
    identify = (...args: Parameters<WorkspaceDirectory["identify"]>) => this.directory.identify(...args);
}
