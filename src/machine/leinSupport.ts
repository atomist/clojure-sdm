/*
 * Copyright © 2018 Atomist, Inc.
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

import {
    HandlerContext, logger,
} from "@atomist/automation-client";
import { GitHubRepoRef } from "@atomist/automation-client/operations/common/GitHubRepoRef";
import { GitProject } from "@atomist/automation-client/project/git/GitProject";
import * as clj from "@atomist/clj-editors";
import {
    allSatisfied,
    Builder,
    editorAutofixRegistration,
    ExecuteGoalResult,
    ExtensionPack,
    hasFile,
    ProjectLoader,
    RunWithLogContext,
    StatusForExecuteGoal,
} from "@atomist/sdm";
import * as build from "@atomist/sdm/dsl/buildDsl";
import { DockerBuildGoal, VersionGoal } from "@atomist/sdm/goal/common/commonGoals";
import { branchFromCommit } from "@atomist/sdm/internal/delivery/build/executeBuild";
import {
    executeVersioner,
    ProjectVersioner,
} from "@atomist/sdm/internal/delivery/build/local/projectVersioner";
import { SpawnBuilder } from "@atomist/sdm/internal/delivery/build/local/SpawnBuilder";
import { IsLein } from "@atomist/sdm/mapping/pushtest/jvm/jvmPushTests";
import {
    DockerImageNameCreator,
    DockerOptions,
    executeDockerBuild,
} from "@atomist/sdm/pack/docker/executeDockerBuild";
import {
    asSpawnCommand,
    spawnAndWatch,
} from "@atomist/sdm/util/misc/spawned";
import { SpawnOptions } from "child_process";
import * as df from "dateformat";
import * as fs from "fs";
import * as _ from "lodash";
import * as path from "path";
import * as util from "util";

const imageNamer: DockerImageNameCreator =
    async (p: GitProject, status: StatusForExecuteGoal.Fragment, options: DockerOptions, ctx: HandlerContext) => {
    const projectclj = path.join(p.baseDir, "project.clj");
    logger.info(`Docker Image name is generated from ${projectclj} name and version ${clj.getName(projectclj)}`);
    return {name: clj.getName(projectclj),
            registry: options.registry,
            version: clj.getVersion(projectclj)};
};

export const LeinSupport: ExtensionPack = {
    name: "Leiningen Support",
    vendor: "Atomist",
    version: "0.1.0",
    configure: sdm => {

        sdm.addBuildRules(
            build.when(IsLein)
                .itMeans("Lein build")
                .set(leinBuilder(sdm.configuration.sdm.projectLoader)),
        );

        sdm.addGoalImplementation("leinVersioner", VersionGoal,
                executeVersioner(sdm.configuration.sdm.projectLoader, LeinProjectVersioner), { pushTest: IsLein })
           .addGoalImplementation("leinDockerBuild", DockerBuildGoal,
                executeDockerBuild(
                    sdm.configuration.sdm.projectLoader,
                    imageNamer,
                    [MetajarPreparation],
                    {
                        ...sdm.configuration.sdm.docker.jfrog as DockerOptions,
                        dockerfileFinder: async () => "docker/Dockerfile",
                    }), { pushTest: allSatisfied(IsLein, hasFile("docker/Dockerfile")) })
           .addAutofixes(
                editorAutofixRegistration(
                    {
                        name: "cljformat",
                        editor: async p => {
                            await clj.cljfmt(p.baseDir);
                            return p;
                        },
                        pushTest: IsLein,
                    }));
    },
};

const key = "(12 15 6 4 13 3 9 10 0 8 8 14 7 16 0 3)";
const vault = path.join(fs.realpathSync(__dirname), "../../../resources/vault.txt");
const defaultEncryptedEnv = {env: clj.vault(key, vault)};
logger.info(`default encrypted env:  ${util.inspect(defaultEncryptedEnv)}`);

function leinBuilder(projectLoader: ProjectLoader): Builder {
    return new SpawnBuilder(
        {
            projectLoader,
            options: {
                name: "atomist.sh",
                commands: [asSpawnCommand("./atomist.sh", {env: {}})],
                errorFinder: (code, signal, l) => {
                    return code !== 0;
                },
                logInterpreter: log => {
                    return {
                        // We don't yet know how to interpret clojure logs
                        relevantPart: undefined,
                        message: "lein errors",
                    };
                },
                enrich: async (options: SpawnOptions, p: GitProject): Promise<SpawnOptions> => {
                    logger.info(`run build enrichment on SpawnOptions`);
                    const encryptedEnv = {env: clj.vault(key, `${p.baseDir}/vault.txt`)};
                    const enriched = _.merge(options, defaultEncryptedEnv, encryptedEnv) as SpawnOptions;
                    logger.info(`enriched: ${util.inspect(encryptedEnv, false, null)}`);
                    return enriched;
                },
                projectToAppInfo: async (p: GitProject) => {
                    const projectClj = await p.findFile("project.clj");
                    logger.info(`run projectToAppInfo in ${p.baseDir}/${projectClj.path}`);
                    return {
                        name: clj.getName(`${p.baseDir}/${projectClj.path}`),
                        version: clj.getVersion(`${p.baseDir}/${projectClj.path}`),
                        id: new GitHubRepoRef( "owner", "repo"),
                    };
                },
                options: {
                    env: {
                        ...process.env,
                    },
                },
            },
        });
}

export async function MetajarPreparation(p: GitProject, rwlc: RunWithLogContext): Promise<ExecuteGoalResult> {
    logger.info(`run ./metajar.sh from ${p.baseDir} with ${util.inspect(defaultEncryptedEnv, false, null)}` );
    const result = await spawnAndWatch(
        {
            command: "./metajar.sh",
            // args: ["with-profile", "metajar", "do", "clean,", "metajar"],
        },
        _.merge( {cwd: p.baseDir}, {env: process.env}, defaultEncryptedEnv),
        rwlc.progressLog,
        {
            errorFinder: code => code !== 0,
        });
    return result;
}

export const LeinProjectVersioner: ProjectVersioner = async (status, p) => {
    const file = path.join(p.baseDir, "project.clj");
    const projectVersion = clj.getVersion(file);
    const branch = branchFromCommit(status.commit);
    const branchSuffix = branch !== status.commit.repo.defaultBranch ? `${branch}.` : "";
    const version = `${projectVersion}-${branchSuffix}${df(new Date(), "yyyymmddHHMMss")}`;

    await clj.setVersion(file, version);

    return version;
};
