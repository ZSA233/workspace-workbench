import type {RepositoryCoverage} from '../../shared/organizer.ts';

/** Refresh health is independent from evidence at a named local production
 * commit. A failed network read cannot prove that a requirement is unshipped. */
export function referenceRefreshFailed(repo:RepositoryCoverage){
 repo.refreshError='远端刷新失败，沿用本地 '+(repo.productionRef||'生产引用');
 if(repo.productionSha&&repo.reason?.startsWith('生产引用获取未确认')){
  delete repo.referenceUnavailable;delete repo.reason;
  repo.state=repo.committedState||repo.state;
 }
}
