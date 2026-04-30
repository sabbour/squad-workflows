/**
 * Board sync — project board state machine transitions.
 */

import { ghGraphQL, getIssue } from './github-api.mjs';
import { loadConfig } from './workflow-config.mjs';

export async function runBoardSync(repoRoot, { issue, targetColumn, token, owner, repo }) {
  const config = loadConfig(repoRoot);
  const validColumns = config.board?.columns || [];

  if (targetColumn && !validColumns.includes(targetColumn)) {
    return {
      error: `Invalid column: "${targetColumn}". Valid: ${validColumns.join(', ')}`,
    };
  }

  // If no target specified, infer from issue state
  if (!targetColumn) {
    targetColumn = await inferColumn(owner, repo, issue, token);
  }

  // Find the project item for this issue
  const itemData = await findProjectItem(owner, repo, issue, token);

  if (!itemData) {
    return {
      issue,
      synced: false,
      reason: 'Issue not found on any project board',
    };
  }

  const { projectId, itemId, statusFieldId, currentColumn, optionId } = itemData;

  // Find the target option
  const targetOptionId = await findColumnOptionId(projectId, statusFieldId, targetColumn, token);

  if (!targetOptionId) {
    return {
      issue,
      synced: false,
      reason: `Column "${targetColumn}" not found in project board`,
    };
  }

  if (currentColumn === targetColumn) {
    return {
      issue,
      synced: true,
      column: targetColumn,
      message: 'Already in correct column',
    };
  }

  // Move the item
  await ghGraphQL(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }`,
    { projectId, itemId, fieldId: statusFieldId, optionId: targetOptionId },
    { token }
  );

  return {
    issue,
    synced: true,
    previousColumn: currentColumn,
    column: targetColumn,
  };
}

async function inferColumn(owner, repo, issue, token) {
  const issueData = await getIssue(owner, repo, issue, token);
  const labels = (issueData.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const state = issueData.state;

  if (state === 'closed') return 'Merged';
  if (labels.some((l) => l.endsWith(':approved'))) return 'Approved';
  if (issueData.pull_request) return 'In Review';
  if (labels.includes('in-progress') || issueData.assignee) return 'In Progress';
  if (issueData.assignee) return 'Assigned';
  return 'Backlog';
}

async function findProjectItem(owner, repo, issue, token) {
  const query = `query($owner: String!, $repo: String!, $issue: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issue) {
        projectItems(first: 10) {
          nodes {
            id
            project { id }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2SingleSelectField { id } }
                  optionId
                }
              }
            }
          }
        }
      }
    }
  }`;

  const data = await ghGraphQL(query, { owner, repo, issue: String(issue) }, { token });
  const items = data?.data?.repository?.issue?.projectItems?.nodes || [];

  if (items.length === 0) return null;

  const item = items[0];
  const statusField = item.fieldValues?.nodes?.find((fv) => fv.field?.id);

  return {
    projectId: item.project?.id,
    itemId: item.id,
    statusFieldId: statusField?.field?.id,
    currentColumn: statusField?.name,
    optionId: statusField?.optionId,
  };
}

async function findColumnOptionId(projectId, statusFieldId, targetColumn, token) {
  const query = `query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 30) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
          }
        }
      }
    }
  }`;

  const data = await ghGraphQL(query, { projectId }, { token });
  const fields = data?.data?.node?.fields?.nodes || [];
  const statusField = fields.find((f) => f.id === statusFieldId);

  if (!statusField) return null;

  const option = statusField.options?.find(
    (o) => o.name.toLowerCase() === targetColumn.toLowerCase()
  );
  return option?.id || null;
}
