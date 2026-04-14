# Azure DevOps Plugin

The Azure DevOps plugin owns every interaction with dev.azure.com in DevOps Pilot: work item tracking, sprints and iterations, velocity, teams, area paths, burndown, and AB# auto-linking.

## Phase 2/3 extraction state

During extraction the handlers still live in `dashboard/server.js`. The manifest uses absolute route paths under `/api/workitems/*`, `/api/iterations`, etc. Phase 3b moves the implementations into this plugin's `routes.js` and flips the manifest paths to relative.

## Routes described by the manifest

| Surface              | Current path                              | Purpose                                 |
|----------------------|-------------------------------------------|-----------------------------------------|
| List work items      | `GET /api/workitems`                      | Backlog / My Items / Iteration views    |
| Create work item     | `POST /api/workitems/create`              | Gated                                   |
| Get work item        | `GET /api/workitems/:id`                  | Detail view                             |
| Change state         | `PATCH /api/workitems/:id/state`          | Gated                                   |
| Comment              | `POST /api/workitems/:id/comments`        | Gated                                   |
| Iterations           | `GET /api/iterations`                     | Iteration selector                      |
| Teams                | `GET /api/teams`                          | Teams sidebar                           |
| Team members         | `GET /api/team-members`                   | Team capacity UI                        |
| Areas                | `GET /api/areas`                          | Area path picker                        |
| Velocity             | `GET /api/velocity`                       | Velocity widget                         |
| Burndown             | `GET /api/burndown`                       | Burndown chart                          |
| Start working        | `POST /api/start-working`                 | Moves item to Active, creates branch    |

## Contributions

- `workItemProvider` exposes the full work-item surface so the future provider-agnostic Backlog tab renders ADO via the same interface Jira/Wrike plugins will implement.
- `centerTabs` contributes the Backlog and Work Item tabs.
- `rightTabs` contributes Teams and Activity sidebars.
- `leftQuickActions` contributes "New Item", "My Items", "Refresh".
- `aiActions` contributes the "Standup Summary", "Iteration Status", and "Retrospective" quick AI actions.
- `commitLinkers` registers the `AB#<id>` auto-link resolver.
- `settingsHtml` will host the ADO org URL, PAT, default team, and default area path fields in Phase 3b.

## Configuration

Reads `ADO_Organization`, `ADO_Project`, `ADO_PAT`, `DefaultTeam`, `DefaultArea` from the global app config. When the config pane moves into this plugin it will continue to write to the same keys.

## AB# auto-link

The `commitLinkers` pattern `AB#(\d+)` maps to `{adoOrgUrl}/_workitems/edit/{1}`. The token `{adoOrgUrl}` is resolved by the shell using the current ADO org URL from config; plugins do not embed org URLs.

## Workflow rules (owned by this plugin)

### Work item creation

When creating work items through this plugin, ALWAYS include:

1. **Title** -- clear, concise, descriptive (plain text, no special characters)
2. **Description** -- detailed enough to understand the full scope; include context, what needs to happen, and why
3. **Story Points** -- estimate 1, 2, 3, 5, 8, or 13 based on complexity
4. **Priority** -- default to 2 (Normal) unless specified
5. **Acceptance Criteria** -- for features / user stories; skip for small bugs
6. **Iteration** -- use `selectedIteration` from `/api/ui/context`; if null ("All Iterations"), leave `iterationPath` empty; NEVER assume the current sprint

### State transitions

When moving a work item to **Active** or **Resolved**:

1. Fetch team members from `/api/team-members`
2. Look up the `DefaultUser` from `/api/config`
3. If found in the team, assign the work item to them; otherwise leave unassigned

State progression: `New -> Active -> Resolved -> Closed`.

### Work item lifecycle during development

Follow this sequence when working on a task tied to a work item:

1. **Start working** -- AUTOMATICALLY move the item to **Active** (via `/api/start-working` or manually). Do not wait for the user.
2. **Write code** -- work item stays Active.
3. **Show diff** using `Show-Diff.ps1 -Repo '<name>'` -- let the user review.
4. **Commit** -- ask "Ready to commit?".
5. **After commit** -- ask "Want me to move AB#<id> to Resolved?" and act on confirmation. Never forget this step.
6. **Push / PR** -- only when the user asks.

Always include `AB#<id>` in commit messages and branch names so the GitHub <-> ADO crosswalk auto-links.

### Plugin scripts

Under `./dashboard/plugins/azure-devops/scripts/`:

| Script | Purpose |
|---|---|
| `Get-SprintStatus.ps1` | Current sprint overview |
| `Get-StandupSummary.ps1 -IterationPath '...'` | Standup of recent changes |
| `Get-Retrospective.ps1` | Last completed sprint analysis |
| `Get-WorkItem.ps1 -Id <id>` | Full work item detail |
| `New-WorkItem.ps1 -Type '...' -Title '...' -Priority <n> -StoryPoints <n>` | Create a work item |
| `Set-WorkItemState.ps1 -Id <id> -State <state>` | Change work item state |
| `Find-WorkItems.ps1 -Search '...' -Type '...' -State '...'` | Filter work items |
| `Get-MyWorkItems.ps1 [-State <state>]` | My items grouped by state |
| `Refresh-Board.ps1` | Refresh backlog / board view |

Call with `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./dashboard/plugins/azure-devops/scripts/<Name>.ps1"` from bash.
