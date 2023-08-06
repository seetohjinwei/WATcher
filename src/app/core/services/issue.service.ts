import { Injectable } from '@angular/core';
import { BehaviorSubject, EMPTY, forkJoin, Observable, of, Subscription, throwError, timer } from 'rxjs';
import { catchError, exhaustMap, finalize, flatMap, map } from 'rxjs/operators';
import RestGithubIssueFilter from '../models/github/github-issue-filter.model';
import { GithubIssue } from '../models/github/github-issue.model';
import { Issue, Issues, IssuesFilter } from '../models/issue.model';
import { Phase } from '../models/phase.model';
import { GithubService } from './github.service';
import { PhaseService } from './phase.service';
import { UserService } from './user.service';

@Injectable({
  providedIn: 'root'
})

/**
 * Responsible for creating and updating issues, and periodically fetching issues
 * using GitHub.
 */
export class IssueService {
  static readonly POLL_INTERVAL = 5000; // 5 seconds

  issues: Issues;
  issues$: BehaviorSubject<Issue[]>;

  private sessionId: string;
  private issueTeamFilter = 'All Teams';
  private issuesPollSubscription: Subscription;
  /** Whether the IssueService is downloading the data from Github*/
  public isLoading = new BehaviorSubject<boolean>(false);

  constructor(private githubService: GithubService, private userService: UserService, private phaseService: PhaseService) {
    this.issues$ = new BehaviorSubject(new Array<Issue>());
  }

  startPollIssues() {
    if (this.issuesPollSubscription === undefined) {
      if (this.issues$.getValue().length === 0) {
        this.isLoading.next(true);
      }

      this.issuesPollSubscription = timer(0, IssueService.POLL_INTERVAL)
        .pipe(
          exhaustMap(() => {
            return this.reloadAllIssues().pipe(
              catchError(() => {
                return EMPTY;
              }),
              finalize(() => this.isLoading.next(false))
            );
          })
        )
        .subscribe();
    }
  }

  stopPollIssues() {
    if (this.issuesPollSubscription) {
      this.issuesPollSubscription.unsubscribe();
      this.issuesPollSubscription = undefined;
    }
  }

  reloadAllIssues() {
    return this.initializeData();
  }

  getIssue(id: number): Observable<Issue> {
    if (this.issues === undefined) {
      return this.getLatestIssue(id);
    } else {
      return of(this.issues[id]);
    }
  }

  getLatestIssue(id: number): Observable<Issue> {
    return this.githubService.fetchIssueGraphql(id).pipe(
      map((response: GithubIssue) => {
        this.createAndSaveIssueModels([response]);
        return this.issues[id];
      }),
      catchError((err) => {
        return of(this.issues[id]);
      })
    );
  }

  /**
   * This function will update the issue's state of the application. This function needs to be called whenever a issue is added/updated.
   *
   * @params issuesToUpdate - An array of issues to update the state of the application with.
   * @params shouldEmit - Whether the updated issues should be emitted to issues$.
   */
  updateLocalStore(issuesToUpdate: Issue[], shouldEmit: boolean = true) {
    const newIssues = issuesToUpdate.reduce((obj, issue) => {
      obj[issue.id] = issue;
      return obj;
    }, {});

    this.issues = { ...this.issues, ...newIssues };

    if (shouldEmit) {
      this.issues$.next(Object.values(this.issues));
    }
  }

  reset(resetSessionId: boolean) {
    if (resetSessionId) {
      this.sessionId = undefined;
    }

    this.issues = undefined;
    this.issues$.next(new Array<Issue>());

    this.stopPollIssues();
    this.isLoading.complete();
    this.isLoading = new BehaviorSubject<boolean>(false);
  }

  private initializeData(): Observable<Issue[]> {
    const issuesAPICallsByFilter: Array<Observable<Array<GithubIssue>>> = [];

    switch (IssuesFilter[this.phaseService.currentPhase][this.userService.currentUser.role]) {
      case 'FILTER_BY_CREATOR':
        issuesAPICallsByFilter.push(
          this.githubService.fetchIssuesGraphql(new RestGithubIssueFilter({ creator: this.userService.currentUser.loginId }))
        );
        break;
      case 'NO_FILTER':
        issuesAPICallsByFilter.push(this.githubService.fetchIssuesGraphql(new RestGithubIssueFilter({})));
        break;
      case 'NO_ACCESS':
      default:
        return of([]);
    }

    return forkJoin(issuesAPICallsByFilter).pipe(
      map((issuesByFilter: GithubIssue[][]) => {
        const fetchedIssueIds: number[] = [];

        // Take each issue and put it in next in issues$
        for (const githubIssues of issuesByFilter) {
          const issues = this.createAndSaveIssueModels(githubIssues);
          for (const issue of issues) {
            fetchedIssueIds.push(issue.id);
          }
        }

        const outdatedIssueIds: number[] = this.getOutdatedIssueIds(fetchedIssueIds);
        this.deleteIssuesFromLocalStore(outdatedIssueIds);

        return Object.values(this.issues);
      })
    );
  }

  private createAndSaveIssueModels(githubIssues: GithubIssue[], shouldEmit: boolean = true): Issue[] {
    const issues: Issue[] = [];

    for (const githubIssue of githubIssues) {
      const issue = this.createIssueModel(githubIssue);
      issues.push(issue);
    }
    this.updateLocalStore(issues, shouldEmit);

    return issues;
  }

  private deleteIssuesFromLocalStore(ids: number[], shouldEmit: boolean = true): void {
    const withoutIssuesToRemove = { ...this.issues };
    for (const id of ids) {
      delete withoutIssuesToRemove[id];
    }

    this.issues = withoutIssuesToRemove;

    if (shouldEmit) {
      this.issues$.next(Object.values(this.issues));
    }
  }

  /**
   * Returns an array of outdated issue ids by comparing the ids of the recently
   * fetched issues with the current issue ids in the local store
   */
  private getOutdatedIssueIds(fetchedIssueIds: number[]): number[] {
    /*
      Ignore for first fetch or ignore if there is no fetch result

      We also have to ignore for no fetch result as the cache might return a
      304 reponse with no differences in issues, resulting in the fetchIssueIds
      to be empty
    */
    if (this.issues === undefined || !fetchedIssueIds.length) {
      return [];
    }

    const fetchedIssueIdsSet = new Set<Number>(fetchedIssueIds);

    const result = Object.keys(this.issues)
      .map((x) => +x)
      .filter((issueId) => !fetchedIssueIdsSet.has(issueId));

    return result;
  }

  private createIssueModel(githubIssue: GithubIssue): Issue {
    switch (this.phaseService.currentPhase) {
      case Phase.issuesViewer:
        return Issue.createPhaseBugReportingIssue(githubIssue);
      default:
        return;
    }
  }

  setIssueTeamFilter(filterValue: string) {
    if (filterValue) {
      this.issueTeamFilter = filterValue;
    }
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  getIssueTeamFilter(): string {
    return this.issueTeamFilter;
  }
}
