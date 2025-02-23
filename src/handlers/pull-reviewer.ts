import { logger } from "../helpers/errors";
import { formatSpecAndPull } from "../helpers/format-spec-and-pull";
import { fetchIssue } from "../helpers/issue-fetching";
import { CodeReviewStatus } from "../types/pull-requests";
import { fetchRepoLanguageStats, fetchRepoDependencies } from "./ground-truths/fetch-deps";
import { findGroundTruths } from "./ground-truths/find-ground-truths";
import { Context } from "../types";
import { CallbackResult } from "../types/proxy";
import { parseLooseJson } from "../helpers/loose-json-parsing";
import { closedByPullRequestsReferences, IssuesClosedByThisPr } from "../helpers/gql-queries";

export class PullReviewer {
  context: Context;
  private _oneDay = 24 * 60 * 60 * 1000;

  constructor(context: Context<"pull_request.opened" | "pull_request.ready_for_review">) {
    this.context = context;
  }

  /**
   * Perform initial checks on a pull request to determine if review is needed
   * @returns CallbackResult indicating the status and reason
   */
  async performPullPrecheck(): Promise<CallbackResult> {
    const { logger, payload } = this.context;
    const { pull_request } = payload;

    // Check if PR is in draft mode, closed, or if we can perform a review
    if (pull_request.draft) {
      return { status: 200, reason: logger.info("PR is in draft mode, no action required").logMessage.raw };
    } else if (pull_request.state === "closed") {
      return { status: 200, reason: logger.info("PR is closed, no action required").logMessage.raw };
    } else if (!(await this.canPerformReview())) {
      return { status: 200, reason: logger.info("Cannot perform review at this time").logMessage.raw };
    }

    return await this._handleCodeReview();
  }

  /**
   * Handle the code review process for a pull request
   * @returns CallbackResult indicating the status and reason
   */
  private async _handleCodeReview(): Promise<CallbackResult> {
    const { payload } = this.context;
    const pullReviewData = await this.reviewPull();
    const { reviewComment, confidenceThreshold } = this.parsePullReviewData(pullReviewData.answer);

    if (confidenceThreshold < 0.5) {
      await this.convertPullToDraft(payload.pull_request.node_id, this.context.octokit);
    }

    await this.submitCodeReview(reviewComment, confidenceThreshold > 0.5 ? "COMMENT" : "REQUEST_CHANGES");
    return { status: 200, reason: "Success" };
  }

  /**
   * Submit a code review for a pull request
   * @param review - The review comment
   * @param status - The review status (APPROVE, REQUEST_CHANGES, COMMENT)
   */
  async submitCodeReview(review: string, status: CodeReviewStatus): Promise<void> {
    const { logger, payload } = this.context;
    const { number, organization, repository, action, sender } = payload;
    const { owner, name } = repository;

    logger.info(`${organization}/${repository}#${number} - ${action} - ${sender.login} - ${review}`);

    try {
      const response = await this.context.octokit.rest.pulls.createReview({
        owner: owner.login,
        repo: name,
        pull_number: number,
        body: review,
        event: status,
      });
      logger.info(`Code review submitted: ${response.data.html_url}`);
    } catch (er) {
      throw logger.error("Failed to submit code review", { err: er });
    }
  }

  /**
   * Check if a review can be performed on the pull request
   * @returns boolean indicating if review can be performed
   */
  async canPerformReview(): Promise<boolean> {
    const { logger, payload } = this.context;
    const { number, organization, repository, action } = payload;
    const { owner, name } = repository;

    logger.info(`${organization}/${repository}#${number} - ${action}`);
    const timeline = await this.context.octokit.rest.issues.listEvents({
      owner: owner.login,
      repo: name,
      issue_number: number,
    });

    const reviews = timeline.data.filter((event) => event.event === "reviewed");
    const botReviews = reviews.filter((review) => review.actor.type === "Bot");

    if (!botReviews.length) {
      logger.info("No bot reviews found");
      return true;
    }

    const lastReview = botReviews[botReviews.length - 1];
    const lastReviewDate = new Date(lastReview.created_at);
    const now = new Date();
    const diff = now.getTime() - lastReviewDate.getTime();

    if (diff < this._oneDay) {
      throw logger.error("Only one review per day is allowed");
    }

    logger.info("One review per day check passed");
    return true;
  }

  /**
   * Convert a pull request to draft mode
   * @param shouldConvert - Whether to convert the PR to draft
   * @param params - Parameters including nodeId and octokit instance
   */
  async convertPullToDraft(nodeId: string, octokit: Context["octokit"]) {
    const toDraft = `mutation {
      convertPullRequestToDraft(input: {pullRequestId: "${nodeId}"}) {
        pullRequest {
          id
          number
          isDraft
          title
        }
      }
    }`;

    try {
      await octokit.graphql(toDraft);
      logger.info(`Successfully converted pull request to draft mode.`);
    } catch (e) {
      throw logger.error("Failed to convert pull request to draft mode: ", { e });
    }
  }

  /**
   * Review a pull request using AI completion
   * @returns The completion result from the AI model
   */
  async reviewPull() {
    const {
      env: { UBIQUITY_OS_APP_NAME },
      config: { anthropicAiModel },
      adapters: {
        anthropic: { completions },
      },
    } = this.context;

    const taskNumber = await this.getTaskNumberFromPullRequest(this.context);
    const issue = await fetchIssue(this.context, taskNumber);

    if (!issue) {
      throw logger.error(`Error fetching issue, Aborting`, {
        owner: this.context.payload.repository.owner.login,
        repo: this.context.payload.repository.name,
        issue_number: taskNumber,
      });
    }

    const taskSpecification = issue.body ?? "";
    const formattedSpecAndPull = await formatSpecAndPull(this.context, issue);
    const [languages, { dependencies, devDependencies }] = await Promise.all([fetchRepoLanguageStats(this.context), fetchRepoDependencies(this.context)]);

    let groundTruths = this._collectGroundTruths(languages, dependencies, devDependencies);

    if (groundTruths.length === 3) {
      return await completions.createCompletion(
        anthropicAiModel,
        formattedSpecAndPull,
        groundTruths,
        UBIQUITY_OS_APP_NAME,
        completions.getModelMaxTokenLimit(anthropicAiModel)
      );
    }

    groundTruths = await findGroundTruths(this.context, { taskSpecification });
    return await completions.createCompletion(
      anthropicAiModel,
      formattedSpecAndPull,
      groundTruths,
      UBIQUITY_OS_APP_NAME,
      completions.getModelMaxTokenLimit(anthropicAiModel)
    );
  }

  /**
   * Collect ground truths based on repository analysis
   */
  private _collectGroundTruths(languages: [string, number][], dependencies: Record<string, string>, devDependencies: Record<string, string>): string[] {
    const groundTruths: string[] = [];

    if (!languages.length) {
      groundTruths.push("No languages found in the repository");
    }
    if (dependencies && !Reflect.ownKeys(dependencies).length) {
      groundTruths.push("No dependencies found in the repository");
    }
    if (devDependencies && !Reflect.ownKeys(devDependencies).length) {
      groundTruths.push("No devDependencies found in the repository");
    }

    return groundTruths;
  }

  async checkIfPrClosesIssues(
    octokit: Context["octokit"],
    pr: {
      owner: string;
      repo: string;
      pr_number: number;
    }
  ) {
    const { owner, repo, pr_number } = pr;

    if (!pr_number) {
      throw new Error("[checkIfPrClosesIssues]: pr_number is required");
    }
    try {
      const result = await octokit.graphql<IssuesClosedByThisPr>(closedByPullRequestsReferences, {
        owner,
        repo,
        pr_number,
      });

      const closingIssues = result.repository.pullRequest.closingIssuesReferences.edges.map((edge) => ({
        number: edge.node.number,
        title: edge.node.title,
        url: edge.node.url,
        body: edge.node.body,
        repository: {
          name: edge.node.name,
          owner: edge.node.owner,
        },
      }));

      if (closingIssues.length > 0) {
        return {
          closesIssues: true,
          issues: closingIssues,
        };
      } else {
        return {
          closesIssues: false,
          issues: [],
        };
      }
    } catch (error) {
      console.error("Error fetching closing issues:", error);
      return {
        closesIssues: false,
        issues: [],
      };
    }
  }
  async getTaskNumberFromPullRequest(context: Context<"pull_request.opened" | "pull_request.ready_for_review">) {
    const {
      payload: { pull_request },
      logger,
    } = context;
    let issueNumber;

    const { issues: closingIssues } = await this.checkIfPrClosesIssues(context.octokit, {
      owner: pull_request.base.repo.owner.login,
      repo: pull_request.base.repo.name,
      pr_number: pull_request.number,
    });

    if (closingIssues.length === 0) {
      const linkedViaBodyHash = pull_request.body?.match(/#(\d+)/g);

      if (linkedViaBodyHash?.length) {
        issueNumber = Number(linkedViaBodyHash[0].replace("#", ""));
      } else {
        await this.convertPullToDraft(context.payload.pull_request.node_id, context.octokit);
        throw context.logger.error("You need to link an issue and after that convert the PR to ready for review");
      }
    } else if (closingIssues.length > 1) {
      throw logger.error("Multiple tasks linked to this PR, needs investigated to see how best to handle it.", {
        closingIssues,
        pull_request,
      });
    } else {
      issueNumber = closingIssues[0].number;
    }

    if (!issueNumber) {
      throw logger.error("Task number not found", { pull_request });
    }

    return issueNumber;
  }
  parsePullReviewData(input: string) {
    try {
      const parsedInput = parseLooseJson<{ confidenceThreshold: number; reviewComment: string }>(input);
      console.error(parsedInput);
      const { confidenceThreshold: rawThreshold, reviewComment: rawComment } = parsedInput;

      if (typeof rawThreshold !== "number" && (typeof rawThreshold !== "string" || isNaN(Number(rawThreshold)))) {
        throw logger.error("Invalid or missing confidenceThreshold", parsedInput);
      }

      if (typeof rawComment !== "string") {
        throw logger.error("Invalid or missing reviewComment", parsedInput);
      }

      const confidenceThreshold = Number(rawThreshold);
      const reviewComment = rawComment;

      return { confidenceThreshold, reviewComment };
    } catch (e) {
      throw logger.error("Couldn't parse JSON output; Aborting", { e });
    }
  }
}
