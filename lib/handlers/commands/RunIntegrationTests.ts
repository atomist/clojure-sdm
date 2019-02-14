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

import {
    GitHubRepoRef,
    GitProject,
    Parameters,
    Secret,
    Secrets,
} from "@atomist/automation-client";
import {
    CommandHandlerRegistration,
    LoggingProgressLog,
    SoftwareDeliveryMachine,
    spawnPromise,
} from "@atomist/sdm";
import { enrich } from "@atomist/sdm-pack-clojure/lib/machine/leinSupport";

@Parameters()
export class IntegrationTestParams {

    @Secret(Secrets.userToken("repo"))
    public githubToken: string;

}

export function runIntegrationTests(sdm: SoftwareDeliveryMachine): CommandHandlerRegistration<IntegrationTestParams> {
    return {
        name: "RunIntegrationTests",
        description: "run platform integration tests",
        intent: "testinate",
        paramsMaker: IntegrationTestParams,
        listener: async cli => {
            await cli.addressChannels(`Running integration tests ...`);
            const testResult = await sdm.configuration.sdm.projectLoader.doWithProject({
                id: GitHubRepoRef.from({owner: "atomisthq", repo: "org-service"}),
                credentials: {token: cli.parameters.githubToken},
                context: cli.context,
                readOnly: true,

            }, async (project: GitProject) => {
                const spawnOptions = await enrich({}, project);
                const result = await spawnPromise(
                    "./integration.sh", [], {
                        env: spawnOptions.env,
                        cwd: project.baseDir,
                    });
                const progressLog = new LoggingProgressLog("console-log");
                progressLog.write(result.stdout);
                progressLog.write(result.stderr);
                return result;
            });
            if (testResult.status === 0) {
                await cli.addressChannels(`All tests passed!`);
            } else {
                await cli.addressChannels(`Boo! There were test failures. I wish I could tell you more.`);
            }
        },
    };
}
