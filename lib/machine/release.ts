/*
 * Copyright © 2019 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// tslint:disable:max-file-line-count

import {
    configurationValue,
    GitCommandGitProject,
    GitHubRepoRef,
    GitProject,
    logger,
    RemoteRepoRef,
    Success,
    TokenCredentials,
} from "@atomist/automation-client";
import {
    DelimitedWriteProgressLogDecorator,
    ExecuteGoal,
    ExecuteGoalResult,
    GoalInvocation,
    PrepareForGoalExecution,
    ProgressLog,
    ProjectLoader,
    spawnLog,
    SpawnLogOptions,
} from "@atomist/sdm";
import {
    createTagForStatus,
    github,
    ProjectIdentifier,
    readSdmVersion,
} from "@atomist/sdm-core";
import {
    DockerOptions,
    DockerRegistry,
} from "@atomist/sdm-pack-docker";

interface ProjectRegistryInfo {
    registry: string;
    name: string;
    version: string;
}

export async function rwlcVersion(gi: GoalInvocation): Promise<string> {
    const goalEvent = gi.goalEvent;
    const version = await readSdmVersion(
        goalEvent.repo.owner,
        goalEvent.repo.name,
        goalEvent.repo.providerId,
        goalEvent.sha,
        goalEvent.branch,
        gi.context);
    return version;
}

function releaseVersion(version: string): string {
    return version.replace(/-.*/, "");
}

function dockerImage(p: ProjectRegistryInfo): string {
    return `${p.registry}/${p.name}:${p.version}`;
}

type ExecuteLogger = (l: ProgressLog) => Promise<ExecuteGoalResult>;

interface SpawnWatchCommand {
    cmd: {
        command: string,
        args: string[],
    };
    cwd?: string;
}

/**
 * Transform a SpawnWatchCommand into an ExecuteLogger suitable for
 * execution by executeLoggers.  The operation is awaited and any
 * thrown exceptions are caught and transformed into an error result.
 * If an error occurs, it is logged.  The result of the operation is
 * transformed into a ExecuteGoalResult.  If an exception is caught,
 * the returned code is guaranteed to be non-zero.
 */
function spawnExecuteLogger(swc: SpawnWatchCommand): ExecuteLogger {

    return async (log: ProgressLog) => {

        const opts: SpawnLogOptions = { log };

        if (swc.cwd) {
            opts.cwd = swc.cwd;
        }

        const res = await spawnLog(swc.cmd.command, swc.cmd.args, opts);

        if (res.error) {
            if (!res.message) {
                res.message = `Spawned command failed (status:${res.code}): ${swc.cmd.command} ${swc.cmd.args.join(" ")}`;
            }
            logger.error(res.message);
            log.write(res.message);
        }

        return res;
    };
}
/**
 * Transform a GitCommandGitProject operation into an ExecuteLogger
 * suitable for execution by executeLoggers.  The operation is awaited
 * and any thrown exceptions are caught and transformed into an error
 * result.  The returned standard out and standard error are written
 * to the log.  If an error occurs, it is logged.  The result of the
 * operation is transformed into a ExecuteGoalResult.  If an error is
 * returned or exception caught, the returned code is guaranteed to be
 * non-zero.
 */
function gitExecuteLogger(
    gp: GitCommandGitProject,
    op: () => Promise<GitCommandGitProject>,
    name: string,
): ExecuteLogger {

    return async (log: ProgressLog) => {
        log.write(`Running: git ${name}`);
        try {
            await op();
            log.write(`Success: git ${name}`);
            return { code: 0 };
        } catch (e) {
            log.write(e.stdout);
            log.write(e.stderr);
            const message = `Failure: git ${name}: ${e.message}`;
            log.write(message);
            return {
                code: e.code,
                message,
            };
        }
    };
}

/**
 * Execute an array of logged commands, creating a line-delimited
 * progress log beforehand, flushing after each command, and closing
 * it at the end.  If any command fails, bail out and return the
 * failure result.  Otherwise return Success.
 */
async function executeLoggers(els: ExecuteLogger[], progressLog: ProgressLog): Promise<ExecuteGoalResult> {
    const log = new DelimitedWriteProgressLogDecorator(progressLog, "\n");
    for (const cmd of els) {
        const res = await cmd(log);
        await log.flush();
        if (res.code !== 0) {
            await log.close();
            return res;
        }
    }
    await log.close();
    return Success;
}

function singleRegistry(options: DockerOptions): DockerRegistry {
    return Array.isArray(options.registry) ? options.registry[0] : options.registry;
}

export async function dockerReleasePreparation(p: GitProject, rwlc: GoalInvocation): Promise<ExecuteGoalResult> {
    const version = await rwlcVersion(rwlc);
    const dockerOptions = configurationValue<DockerOptions>("sdm.docker.hub");
    const image = dockerImage({
        registry: singleRegistry(dockerOptions).registry,
        name: p.name,
        version,
    });

    const cmds: SpawnWatchCommand[] = [
        {
            cmd: {
                command: "docker",
                args: ["login", "--username", singleRegistry(dockerOptions).user, "--password", singleRegistry(dockerOptions).password],
            },
        },
        {
            cmd: { command: "docker", args: ["pull", image] },
        },
    ];
    const els = cmds.map(spawnExecuteLogger);
    return executeLoggers(els, rwlc.progressLog);
}

export const DockerReleasePreparations: PrepareForGoalExecution[] = [dockerReleasePreparation];

export function executeReleaseDocker(
    projectLoader: ProjectLoader,
    preparations: PrepareForGoalExecution[] = DockerReleasePreparations,
    options?: DockerOptions,
): ExecuteGoal {

    return async (rwlc: GoalInvocation): Promise<void | ExecuteGoalResult> => {
        const { credentials, id, context } = rwlc;
        if (!options.registry) {
            throw new Error(`No registry defined in Docker options`);
        }
        return projectLoader.doWithProject({ credentials, id, context, readOnly: false }, async (project: GitProject) => {

            for (const preparation of preparations) {
                const pResult = await preparation(project, rwlc);
                if (pResult && pResult.code !== 0) {
                    return pResult;
                }
            }

            const version = await rwlcVersion(rwlc);
            const versionRelease = releaseVersion(version);
            const image = dockerImage({
                registry: singleRegistry(options).registry,
                name: rwlc.id.repo,
                version,
            });
            const tag = dockerImage({
                registry: singleRegistry(options).registry,
                name: rwlc.id.repo,
                version: versionRelease,
            });

            const cmds: SpawnWatchCommand[] = [
                {
                    cmd: { command: "docker", args: ["tag", image, tag] },
                },
                {
                    cmd: { command: "docker", args: ["push", tag] },
                },
                {
                    cmd: { command: "docker", args: ["rmi", tag] },
                },
            ];
            const els = cmds.map(spawnExecuteLogger);
            return executeLoggers(els, rwlc.progressLog);
        });
    };
}

/**
 * Create release semantic version tag and GitHub release for that tag.
 */
export function executeReleaseTag(projectLoader: ProjectLoader): ExecuteGoal {
    return async (rwlc: GoalInvocation): Promise<ExecuteGoalResult> => {
        const { credentials, id, context } = rwlc;

        return projectLoader.doWithProject({ credentials, id, context, readOnly: true }, async p => {
            const version = await rwlcVersion(rwlc);
            const versionRelease = releaseVersion(version);
            const message = rwlc.goalEvent.push.commits[0].message;
            await createTagForStatus(id, id.sha, message, versionRelease, credentials);
            const commitTitle = message.replace(/\n[\S\s]*/, "");
            const release = {
                tag_name: versionRelease,
                name: `${versionRelease}: ${commitTitle}`,
            };
            const rrr = p.id as RemoteRepoRef;
            const targetUrl = `${rrr.url}/releases/tag/${versionRelease}`;
            const egr: ExecuteGoalResult = {
                ...Success,
                targetUrl,
            };
            return github.createRelease((credentials as TokenCredentials).token, id as GitHubRepoRef, release)
                .then(() => egr);
        });
    };
}

/**
 * Increment patch level in package.json version.
 */
export function executeReleaseVersion(
    projectLoader: ProjectLoader,
    projectIdentifier: ProjectIdentifier,
): ExecuteGoal {

    return async (rwlc: GoalInvocation): Promise<ExecuteGoalResult> => {
        const { credentials, id, context } = rwlc;

        return projectLoader.doWithProject({ credentials, id, context, readOnly: false }, async p => {
            const version = await rwlcVersion(rwlc);
            const versionRelease = releaseVersion(version);
            const gp = p as GitCommandGitProject;

            const branch = "master";
            const remote = gp.remote || "origin";
            const preEls: ExecuteLogger[] = [
                gitExecuteLogger(gp, () => gp.checkout(branch), "checkout"),
                spawnExecuteLogger({ cmd: { command: "git", args: ["pull", remote, branch] }, cwd: gp.baseDir }),
            ];
            const preRes = await executeLoggers(preEls, rwlc.progressLog);
            if (preRes.code !== 0) {
                return preRes;
            }
            gp.branch = branch;

            const pi = await projectIdentifier(p);
            if (pi.version !== versionRelease) {
                const message = `current master package version (${pi.version}) seems to have already been ` +
                    `incremented after ${releaseVersion} release`;
                logger.debug(message);
                const log = new DelimitedWriteProgressLogDecorator(rwlc.progressLog, "\n");
                log.write(`${message}\n`);
                await log.flush();
                await log.close();
                return { ...Success, message };
            }

            const postEls: ExecuteLogger[] = [
                spawnExecuteLogger({ cmd: { command: "npm", args: ["version", "--no-git-tag-version", "patch"] }, cwd: gp.baseDir }),
                gitExecuteLogger(gp, () => gp.commit(`Increment version after ${versionRelease} release`), "commit"),
                gitExecuteLogger(gp, () => gp.push(), "push"),
            ];
            return executeLoggers(postEls, rwlc.progressLog);
        });
    };
}
