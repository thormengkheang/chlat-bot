import { Probot } from 'probot';
import { Context } from 'probot/lib/context';
import { WebhookEvent, EventPayloads } from '@octokit/webhooks';
import slugify from 'slugify';

const ADD_ISSUE_TO_PROJECT = `
  mutation addIssueToProject($id: ID!, $projectId: ID!) {
    updateIssue(input: {id: $id, projectIds: [$projectId]}) {
      issue {
        title
      }
    }
  }
`;

interface Comment {
    name?: string;
    type?: string;
}

type IssueContext = WebhookEvent<EventPayloads.WebhookPayloadIssues> & Omit<Context, 'id' | 'name' | 'payload'>;

const BOT_NAME = 'chlat-bot[bot]';
const MAX_COMMENT_PER_PAGE = 100;
const BRANCH_NAME_MAX_CHAR = 60;

async function isBotComment(context: IssueContext) {
    const owner = context.repo().owner;
    const repo = context.repo().repo;
    const issueNumber = context.payload.issue.number;
    let comments: Comment[] = [];
    const numberOfComment = context.payload.issue.comments;
    const numberOfCommentPage = Math.ceil(numberOfComment / MAX_COMMENT_PER_PAGE);
    for (let i = 1; i <= numberOfCommentPage; i++) {
        const { data } = await context.octokit.issues.listComments({
            owner,
            repo,
            issue_number: issueNumber,
            page: i,
        });
        comments = comments.concat(data.map((e) => ({ name: e.user?.login, type: e.user?.type })));
    }
    return comments.some((e) => e.name === BOT_NAME && e.type === 'Bot');
}

async function addIssueToProject(context: IssueContext, projectId: string, labels: string[]) {
    if (!projectId) {
        context.log.warn('No PROJECT_ID set in .github/config.yml');
        return;
    }
    const issueLabels = context.payload.issue.labels;
    const nodeId = context.payload.issue.node_id;
    const index = issueLabels.findIndex((e) => labels.includes(e.name));
    if (index != -1) {
        try {
            await context.octokit.graphql(ADD_ISSUE_TO_PROJECT, {
                id: nodeId,
                projectId,
            });
        } catch (e) {
            context.log.error(e);
        }
    }
}

async function createBranch(context: IssueContext, sha: string) {
    const owner = context.repo().owner;
    const repo = context.repo().repo;
    const issue = context.payload.issue;
    const branchName = slugify(`${issue.number} ${issue.title.toLowerCase()}`, '_').substring(0, BRANCH_NAME_MAX_CHAR);
    await context.octokit.request('POST /repos/{owner}/{repo}/git/refs', {
        owner,
        repo,
        ref: 'refs/heads/' + branchName,
        sha,
    });
    return branchName;
}

async function getBranchSha(context: IssueContext, branch: string) {
    const owner = context.repo().owner;
    const repo = context.repo().repo;
    if (!branch) {
        context.log.warn('No BASE_BRANCH set in .github/config.yml');
        return;
    }
    const { data } = await context.octokit.repos.getBranch({
        owner,
        repo,
        branch,
    });
    return data.commit.sha;
}

async function commentIssue(context: IssueContext, branchName: string) {
    const issueNumber = context.payload.issue.number;
    const issueBody = `Branch has been created for PR! Please check out the branch\n`;
    const checkOutText = `\`\`\`\ngit fetch origin\ngit checkout -b "${branchName}" "origin/${branchName}"\n\`\`\``;
    const issueComment = context.issue({
        body: issueBody + checkOutText,
        issue_number: issueNumber,
    });
    await context.octokit.issues.createComment(issueComment);
}

async function getConfig(context: IssueContext) {
    const defaultConfig = {
        LABELS: ['bug', 'enhancement'],
        PROJECT_ID: '',
        BASE_BRANCH: '',
    };
    const owner = context.repo().owner;
    const repo = context.repo().repo;
    const { config } = await context.octokit.config.get({
        owner,
        repo,
        path: '.github/config.yml',
        defaults: defaultConfig,
        branch: 'develop',
    });
    return config;
}

function isIssueNotInLabel(context: IssueContext, labels: string[]) {
    const issueLabels = context.payload.issue.labels;
    const index = issueLabels.findIndex((e) => labels.includes(e.name));
    return index === -1;
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export = (app: Probot) => {
    app.on('issues.labeled', async (context) => {
        // Load config from .github/config.yml in the repository and combine with default config
        const config = await getConfig(context);

        if (isIssueNotInLabel(context, config.LABELS)) {
            return;
        }

        const isBotCommented = await isBotComment(context);
        if (isBotCommented) {
            context.log.info('Bot already commented on this issue');
            return;
        }

        await addIssueToProject(context, config.PROJECT_ID, config.LABELS);

        const baseBranchSha = await getBranchSha(context, config.BASE_BRANCH);

        if (baseBranchSha) {
            const branchName = await createBranch(context, baseBranchSha);
            await commentIssue(context, branchName);
        }
    });
};
