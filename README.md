# Azure DevOps Plugin for DevOps Pilot

Integrates Azure DevOps into DevOps Pilot: work items, iterations, teams, velocity, burndown, and `AB#` commit auto-linking.

## Installation

1. Clone into your DevOps Pilot plugins folder:
   ```
   git clone https://github.com/M8N-MatanDessaur/devops-pilot-plugin-azure-devops.git dashboard/plugins/azure-devops
   ```
2. Restart DevOps Pilot.
3. Open **Settings -> Plugins -> Azure DevOps** and fill in your org, project, PAT, and default team.

## What it contributes

- `workItemProvider` -- powers the Backlog center tab and work-item detail view.
- `centerTabs: Backlog, Work Item` and `rightTabs: Teams, Activity`.
- `leftQuickActions: New Item, My Items, Refresh`.
- `aiActions: Standup Summary, Iteration Status, Retrospective`.
- `commitLinkers` -- auto-links `AB#<id>` in commit messages and branch names.
- `nativeSettings` -- claims the Azure DevOps settings block.

## Routes

During the Phase 3 extraction the HTTP handlers still live in core DevOps Pilot under `/api/workitems/*`, `/api/iterations`, `/api/teams`, etc. The manifest points at those absolute paths. A future release will move the handlers into this plugin's `routes.js`.

## Uninstall

Delete the `dashboard/plugins/azure-devops/` folder and restart. Your work items stay in Azure DevOps untouched.
