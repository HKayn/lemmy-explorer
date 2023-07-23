import { readFile } from "node:fs/promises";
import removeMd from "remove-markdown";

import { OUTPUT_MAX_AGE } from "../lib/const.js";

import logging from "../lib/logging.js";
import storage from "../storage.js";

import AxiosClient from "../lib/axios.js";

import Splitter from "./splitter.js";
import { Suspicions } from "./suspicions.js";

/**
 * this generates the .json files for the frontend /public folder
 * it conencts to redis and pulls lists of all the data we have stored
 */
export default class CrawlOutput {
  constructor() {
    this.uptimeData = null;
    this.instanceErrors = null;
    this.communityErrors = null;
    this.instanceList = null;
    this.communityList = null;

    this.splitter = new Splitter();
  }

  // load all required data from redis
  async loadAllData() {
    this.uptimeData = await storage.uptime.getLatest();
    this.instanceErrors = await storage.tracking.getAllErrors("instance");
    this.communityErrors = await storage.tracking.getAllErrors("community");
    this.instanceList = await storage.instance.getAll();
    this.communityList = await storage.community.getAll();

    this.fediverseData = await storage.fediverse.getAll();
    this.kbinData = await storage.kbin.getAll();

    // parse all federated instance data
    const [linkedFederation, allowedFederation, blockedFederation] =
      this.getFederationLists(this.instanceList);

    this.linkedFederation = linkedFederation;
    this.allowedFederation = allowedFederation;
    this.blockedFederation = blockedFederation;
  }

  async isInstanceSus(instance, log = true) {
    const instanceSus = new Suspicions(instance, log);

    return await instanceSus.isSuspicious();
  }

  /**
   * Main Output Generation Script
   */
  async start() {
    await this.loadAllData();

    // delete existing data from the output directory
    await this.splitter.cleanData();

    const susSiteList = await this.outputSusList();

    const returnStats = await this.outputFediverseData();

    const kbinInstanceArray = await this.outputKBinInstanceList(returnStats);

    const kbinMagazineArray = await this.outputKBinMagazineList();

    const returnInstanceArray = await this.getInstanceArray();

    const returnCommunityArray = await this.getCommunityArray(
      returnInstanceArray
    );

    // generate instance-level metrics for every instance
    await Promise.all(
      returnInstanceArray.map(async (instance) => {
        return this.generateInstanceMetrics(instance, returnCommunityArray);
      })
    );

    const instanceErrors = await this.outputClassifiedErrors();

    // STORE RUN METADATA
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url))
    );

    const metaData = {
      instances: returnInstanceArray.length,
      communities: returnCommunityArray.length,
      magazines: kbinMagazineArray.length,
      kbin_instances: kbinInstanceArray.length,
      fediverse: returnStats.length,
      time: Date.now(),
      package: packageJson.name,
      version: packageJson.version,

      // top 10 linked, allowed, blocked domains
      // sort by count of times seen on each list
      linked: this.linkedFederation,
      allowed: this.allowedFederation,
      blocked: this.blockedFederation,
    };
    await this.splitter.storeMetaData(metaData);

    // get previous run  from current production data
    const client = new AxiosClient();
    let previousRun = await client.getUrl(
      "https://lemmyverse.net/data/meta.json"
    );
    previousRun = previousRun.data;

    console.log("Done; Total vs. Output");

    function calcChangeDisplay(current, previous) {
      return `${current > previous ? "+" : ""}${current - previous} (${(
        ((current - previous) / previous) *
        100
      ).toFixed(2)}%)`;
    }

    console.table(
      {
        Instances: {
          ExportName: "Instances",
          Total: this.instanceList.length,
          Output: returnInstanceArray.length,
          Previous: previousRun.instances,
          Change: calcChangeDisplay(
            returnInstanceArray.length,
            previousRun.instances
          ),
        },
        Communities: {
          ExportName: "Communities",
          Total: this.communityList.length,
          Output: returnCommunityArray.length,
          Previous: previousRun.communities,
          Change: calcChangeDisplay(
            returnCommunityArray.length,
            previousRun.communities
          ),
        },
        KBinInstances: {
          ExportName: "KBin Instances",
          Total: "N/A",
          Output: kbinInstanceArray.length,
          Previous: previousRun.kbin_instances,
          Change: calcChangeDisplay(
            kbinInstanceArray.length,
            previousRun.kbin_instances
          ),
        },
        Magazines: {
          ExportName: "Magazines",
          Total: this.kbinData.length,
          Output: kbinMagazineArray.length,
          Previous: previousRun.magazines,
          Change: calcChangeDisplay(
            kbinMagazineArray.length,
            previousRun.magazines
          ),
        },
        Fediverse: {
          ExportName: "Fediverse Servers",
          Total: "N/A",
          Output: returnStats.length,
          Previous: previousRun.fediverse,
          Change: calcChangeDisplay(returnStats.length, previousRun.fediverse),
        },
        ErrorData: {
          ExportName: "Error Data",
          Total: "N/A",
          Output: instanceErrors.length,
        },
        SusSites: {
          ExportName: "Sus Sites",
          Total: "N/A",
          Output: susSiteList.length,
        },
      },
      ["Total", "Output", "Previous", "Change"]
    );

    const validateOutput = await this.validateOutput(
      previousRun,
      returnInstanceArray,
      returnCommunityArray,
      kbinInstanceArray,
      kbinMagazineArray,
      returnStats
    );

    return validateOutput;
  }

  // ensure the output is okay for the website
  async validateOutput(
    previousRun,
    returnInstanceArray,
    returnCommunityArray,
    kbinInstanceArray,
    kbinMagazineArray,
    returnStats
  ) {
    const issues = [];

    // check that there is data in all arrays
    if (
      returnInstanceArray.length === 0 ||
      returnCommunityArray.length === 0 ||
      kbinInstanceArray.length === 0 ||
      kbinMagazineArray.length === 0 ||
      returnStats.length === 0
    ) {
      console.log("Empty Array");
      issues.push("Empty Array(s)");
    }

    // check for duplicate baseurls
    for (let i = 0; i < returnInstanceArray.length; i++) {
      const instance = returnInstanceArray[i];

      const found = returnInstanceArray.find(
        (i) => i.baseurl === instance.baseurl
      );

      if (found && found !== instance) {
        console.log("Duplicate Instance", instance.baseurl);
        issues.push("Duplicate Instance: " + instance.baseurl);
      }
    }

    // check values are < 10% different
    const checkChangeIsValid = (value, previousValue, pct = 10) => {
      if (!value || !previousValue) {
        return false;
      }

      const diff = Math.abs(value - previousValue);
      const percent = (diff / previousValue) * 100;

      if (percent > pct) {
        console.log("Percent Diff", value, previousValue, percent);
        return false;
      }

      return true;
    };

    // check that the output is not too different from the previous run
    const data = [];
    data.push({
      type: "instances",
      new: returnInstanceArray.length,
      old: previousRun.instances,
    });
    data.push({
      type: "communities",
      new: returnCommunityArray.length,
      old: previousRun.communities,
    });

    data.push({
      type: "fediverse",
      new: returnStats.length,
      old: previousRun.fediverse,
    });

    // @TODO kbin checks are disabled till scanning is fixed
    // data.push({
    //   type: "magazines",
    //   new: kbinMagazineArray.length,
    //   old: previousRun.magazines,
    // });
    // data.push({
    //   type: "kbin_instances",
    //   new: kbinInstanceArray.length,
    //   old: previousRun.kbin_instances,
    // });

    for (let i = 0; i < data.length; i++) {
      const item = data[i];

      const isValid = checkChangeIsValid(item.new, item.old);

      if (!isValid) {
        console.log("Percent Diff", item.type, item.new, item.old);
        issues.push("Percent Diff: " + item.type);
      }
    }

    if (issues.length > 0) {
      console.log("Validation Issues", issues);

      throw new Error("Validation Issues: " + issues.join(", "));
    }

    return true;
  }

  /// find updatenode for given baseurl
  getBaseUrlUptime(baseUrl) {
    const foundKey = this.uptimeData.nodes.find((k) => k.domain == baseUrl);
    return foundKey;
  }

  // find a failure for a given baseurl
  findFail(baseUrl) {
    const keyName = `error:instance:${baseUrl}`;

    const value =
      this.instanceErrors[
        Object.keys(this.instanceErrors).find((k) => k === keyName)
      ];

    if (value) {
      return value;
    }

    return null;
  }

  stripMarkdown(text) {
    // strip markdown
    return removeMd(text);
  }

  // given an array, get a d-duped list of all the baseurls, returns three arrays with counts for each
  getFederationLists(instances) {
    // count instances by list
    let linkedFederation = {};
    let allowedFederation = {};
    let blockedFederation = {};

    function dedupAddItem(list, baseUrl) {
      // only add strings
      if (typeof baseUrl !== "string") {
        return;
      }

      if (!list[baseUrl]) {
        list[baseUrl] = 1;
      } else {
        list[baseUrl]++;
      }
    }

    // start crawler jobs for all of the instances this one is federated with
    instances.forEach((instance) => {
      if (!instance.siteData?.federated) {
        // logging.debug("no federated data", instance.siteData.site.actor_id);
        return;
      }

      const { linked, allowed, blocked } = instance.siteData.federated;

      // logging.silly(
      //   `federated instances: ${instance.siteData.site.actor_id}`,
      //   instance.siteData.federated.linked.length
      // );

      if (linked.length > 0) {
        for (const baseUrl of linked) {
          dedupAddItem(linkedFederation, baseUrl);
        }
      }
      if (allowed && allowed.length > 0) {
        for (const baseUrl of allowed) {
          dedupAddItem(allowedFederation, baseUrl);
        }
      }
      if (blocked && blocked.length > 0) {
        for (const baseUrl of blocked) {
          dedupAddItem(blockedFederation, baseUrl);
        }
      }
    });

    // logging.info(
    //   `Federation Linked: ${Object.keys(linkedFederation).length} Allowed: ${
    //     Object.keys(allowedFederation).length
    //   } Blocked: ${Object.keys(blockedFederation).length}`
    // );

    console.log("Global Federation Counts (counts of urls in merged lists)");
    console.table({
      linked: Object.keys(linkedFederation).length,
      allowed: Object.keys(allowedFederation).length,
      blocked: Object.keys(blockedFederation).length,
    });

    return [linkedFederation, allowedFederation, blockedFederation];
  }

  findErrorType(errorMessage) {
    if (
      errorMessage.includes("ENOENT") ||
      errorMessage.includes("ECONNREFUSED") ||
      errorMessage.includes("ECONNRESET") ||
      errorMessage.includes("ENOTFOUND") ||
      errorMessage.includes("EAI_AGAIN") ||
      errorMessage.includes("socket hang up") ||
      errorMessage.includes("Client network socket disconnected")
    ) {
      return "connectException";
    }

    if (errorMessage.includes("timeout of")) {
      return "timeout";
    }

    if (
      errorMessage.includes("self-signed certificate") ||
      errorMessage.includes("does not match certificate's altnames") ||
      errorMessage.includes("tlsv1 unrecognized name") ||
      errorMessage.includes("tlsv1 alert internal error") ||
      errorMessage.includes("ssl3_get_record:wrong version number") ||
      errorMessage.includes("unable to verify the first certificate") ||
      errorMessage.includes("unable to get local issuer certificate") ||
      errorMessage.includes("certificate has expired")
    ) {
      return "sslException";
    }

    if (errorMessage.includes("baseUrl is not a valid domain")) {
      return "invalidBaseUrl";
    }

    if (
      errorMessage.includes("code 300") ||
      errorMessage.includes("code 400") ||
      errorMessage.includes("code 403") ||
      errorMessage.includes("code 404") ||
      errorMessage.includes("code 406") ||
      errorMessage.includes("code 410") ||
      errorMessage.includes("code 500") ||
      errorMessage.includes("code 502") ||
      errorMessage.includes("code 503") ||
      errorMessage.includes("code 520") ||
      errorMessage.includes("code 521") ||
      errorMessage.includes("code 523") ||
      errorMessage.includes("code 525") ||
      errorMessage.includes("code 526") ||
      errorMessage.includes("code 530") ||
      errorMessage.includes("Maximum number of redirects exceeded")
    ) {
      return "httpException";
    }

    if (
      errorMessage.includes("no diaspora rel in") ||
      errorMessage.includes("wellKnownInfo.data.links is not iterable") ||
      errorMessage.includes("missing /.well-known/nodeinfo links")
    ) {
      return "httpException";
    }

    if (errorMessage.includes("not a lemmy instance")) {
      return "notLemmy";
    }

    if (
      errorMessage.includes("invalid actor id") ||
      errorMessage.includes("actor id does not match instance domain")
    ) {
      return "invalidActorId";
    }

    logging.silly("unhandled error", errorMessage);
  }

  async generateInstanceMetrics(instance, storeCommunityData) {
    // get timeseries
    const usersSeries = await storage.instance.getAttributeWithScores(
      instance.baseurl,
      "users"
    );
    const postsSeries = await storage.instance.getAttributeWithScores(
      instance.baseurl,
      "posts"
    );
    const commentsSeries = await storage.instance.getAttributeWithScores(
      instance.baseurl,
      "comments"
    );
    const versionSeries = await storage.instance.getAttributeWithScores(
      instance.baseurl,
      "version"
    );

    // generate array with time -> value
    const users = usersSeries.map((item) => {
      return {
        time: item.score,
        value: item.value,
      };
    });
    const posts = postsSeries.map((item) => {
      return {
        time: item.score,
        value: item.value,
      };
    });
    const comments = commentsSeries.map((item) => {
      return {
        time: item.score,
        value: item.value,
      };
    });
    const versions = versionSeries.map((item) => {
      return {
        time: item.score,
        value: item.value,
      };
    });

    await this.splitter.storeInstanceMetricsData(instance.baseurl, {
      instance,
      communityCount: storeCommunityData.filter(
        (community) => community.baseurl === instance.baseurl
      ).length,
      users,
      posts,
      comments,
      versions,
    });
  }

  async getInstanceArray() {
    let storeData = await Promise.all(
      this.instanceList.map(async (instance) => {
        if (!instance.siteData?.site?.actor_id) {
          logging.error("no actor_id", instance);
          return null;
        }
        let siteBaseUrl = instance.siteData.site.actor_id.split("/")[2];

        const siteUptime = this.getBaseUrlUptime(siteBaseUrl);

        const incomingBlocks = this.blockedFederation[siteBaseUrl] || 0;
        const outgoingBlocks =
          instance.siteData.federated?.blocked?.length || 0;

        let score = 0;
        // having a linked instance gives you a point for each link
        if (this.linkedFederation[siteBaseUrl]) {
          score += this.linkedFederation[siteBaseUrl];
        }

        // each allowed instance gives you points
        if (this.allowedFederation[siteBaseUrl]) {
          score += this.allowedFederation[siteBaseUrl] * 2;
        }

        // each blocked instance takes away points
        if (this.blockedFederation[siteBaseUrl]) {
          score -= this.blockedFederation[siteBaseUrl] * 10;
        }

        // ignore instances that have no data
        const instanceSus = new Suspicions(instance);
        const susReason = await instanceSus.isSuspiciousReasons();

        return {
          baseurl: siteBaseUrl,
          url: instance.siteData.site.actor_id,
          name: instance.siteData.site.name,
          desc: this.stripMarkdown(instance.siteData.site.description),

          // config
          downvotes: instance.siteData.config?.enable_downvotes,
          nsfw: instance.siteData.config?.enable_nsfw,
          create_admin: instance.siteData.config?.community_creation_admin_only,
          private: instance.siteData.config?.private_instance,
          fed: instance.siteData.config?.federation_enabled,

          date: instance.siteData.site.published,
          version: instance.nodeData.software.version,
          open: instance.nodeData.openRegistrations,

          usage: instance.nodeData.usage, // TO BE DEPRECATED
          counts: instance.siteData.counts, // USE THIS INSTEAD

          icon: instance.siteData.site.icon,
          banner: instance.siteData.site.banner,
          langs: instance.langs,

          time: instance.lastCrawled || null,
          score: score,
          uptime: siteUptime,

          isSuspicious: await this.isInstanceSus(instance),
          metrics: instanceSus.metrics,

          blocks: {
            incoming: incomingBlocks,
            outgoing: outgoingBlocks,
          },
        };
      })
    );

    // remove those with errors that happened before time
    storeData = storeData.filter((instance) => {
      if (instance == null) return false; // take out skipped

      const fail = this.findFail(instance.baseurl);
      if (fail) {
        if (instance.time < fail.time) {
          // logging.info("filtered due to fail", instance.baseurl, fail.error);
          return false;
        }
      }
      return true;
    });

    // remove instances not updated in 24h
    storeData = storeData.filter((instance) => {
      if (!instance.time) return false; // record needs time

      // remove communities with age more than the max
      const recordAge = Date.now() - instance.time;
      if (recordAge > OUTPUT_MAX_AGE.INSTANCE) {
        return false;
      }

      return true;
    });

    // filter blank
    storeData = storeData.filter(
      (instance) => instance.url !== "" || instance.name !== ""
    );

    // logging.info(
    //   `Instances ${this.instanceList.length} -> ${storeData.length}`
    // );

    await this.splitter.storeInstanceData(storeData);

    return storeData;
  }

  async getCommunityArray(returnInstanceArray) {
    let storeCommunityData = await Promise.all(
      this.communityList.map(async (community) => {
        let siteBaseUrl = community.community.actor_id.split("/")[2];

        let score = 0;
        // having a linked instance gives you a point for each link
        if (this.linkedFederation[siteBaseUrl]) {
          score += this.linkedFederation[siteBaseUrl];
        }

        // each allowed instance gives you points
        if (this.allowedFederation[siteBaseUrl]) {
          score += this.allowedFederation[siteBaseUrl] * 2;
        }

        // each blocked instance takes away points
        if (this.blockedFederation[siteBaseUrl]) {
          score -= this.blockedFederation[siteBaseUrl] * 10;
        }

        // also score based subscribers
        score = score * community.counts.subscribers;

        const relatedInstance = this.instanceList.find(
          (instance) =>
            instance.siteData.site.actor_id.split("/")[2] === siteBaseUrl
        );
        const isInstanceSus = await this.isInstanceSus(relatedInstance, false);

        // if (community.community.nsfw)
        //   console.log(community.community.name, community.community.nsfw);

        return {
          baseurl: siteBaseUrl,
          url: community.community.actor_id,
          name: community.community.name,
          title: community.community.title,
          desc: this.stripMarkdown(community.community.description).substring(
            0,
            350
          ),
          icon: community.community.icon,
          banner: community.community.banner,
          nsfw: community.community.nsfw,
          counts: community.counts,
          time: community.lastCrawled || null,

          isSuspicious: isInstanceSus,
          score: score,
        };
      })
    );

    // remove those with errors that happened before updated time
    storeCommunityData = storeCommunityData.filter((community) => {
      const fail = this.findFail(community.baseurl);
      if (fail) {
        if (community.time < fail.time) {
          // logging.info("filtered due to fail", fail, community.baseurl);
          return false;
        }
      }
      return true;
    });

    // remove communities not updated in 24h
    storeCommunityData = storeCommunityData.filter((community) => {
      if (!community.time) {
        console.log("no time", community);
        return false; // record needs time
      }

      // remove communities with age more than the max
      const recordAge = Date.now() - community.time;

      // if (recordAge < OUTPUT_MAX_AGE.COMMUNITY && community.nsfw) {
      //   console.log("NFSW Updated Recently!!", community.url);
      //   // return false;
      // }

      // temp fix till lermmy allows querying nsfw on the public api -.-
      if (community.nsfw) {
        return true;
      }

      if (recordAge > OUTPUT_MAX_AGE.COMMUNITY) {
        return false;
      }

      return true;
    });

    // remove those not being in the instance list
    if (returnInstanceArray) {
      storeCommunityData = storeCommunityData.filter((community) => {
        const relatedInstance = returnInstanceArray.find(
          (instance) => instance.baseurl === community.baseurl
        );

        if (!relatedInstance) {
          logging.info("filtered due to no instance", community.url);
          return false;
        }

        return true;
      });
    }

    // filter blank
    storeCommunityData = storeCommunityData.filter(
      (community) =>
        community.url !== "" || community.name !== "" || community.title !== ""
    );

    // logging.info(
    //   `Communities ${this.communityList.length} -> ${storeCommunityData.length}`
    // );

    await this.splitter.storeCommunityData(storeCommunityData);

    return storeCommunityData;
  }

  async outputFediverseData() {
    let returnStats = [];

    let softwareNames = {};
    let softwareBaseUrls = {};

    Object.keys(this.fediverseData).forEach((fediKey) => {
      const fediverse = this.fediverseData[fediKey];
      const baseUrl = fediKey.replace("fediverse:", "");
      if (fediverse.name) {
        if (!softwareBaseUrls[fediverse.name]) {
          softwareBaseUrls[fediverse.name] = [baseUrl];
        } else {
          softwareBaseUrls[fediverse.name].push(baseUrl);
        }

        if (!softwareNames[fediverse.name]) {
          softwareNames[fediverse.name] = 1;
        } else {
          softwareNames[fediverse.name] += 1;
        }

        returnStats.push({
          url: baseUrl,
          software: fediverse.name,
          version: fediverse.version,
        });
      }
    });

    await this.splitter.storeFediverseData(
      returnStats,
      softwareNames,
      softwareBaseUrls
    );

    return returnStats;
  }

  async outputKBinInstanceList(returnStats) {
    let kbinInstances = returnStats
      .map((fediverse) => {
        // const fediverse = this.fediverseData[fediKey];

        if (fediverse.software && fediverse.software === "kbin") {
          return fediverse.url;
        }
        return null;
      })
      .filter((instance) => instance !== null);

    await this.splitter.storeKbinInstanceList(kbinInstances);

    return kbinInstances;
  }

  async outputClassifiedErrors() {
    let instanceErrors = [];

    // key value in errors
    let errorTypes = {};
    for (const [key, value] of Object.entries(this.instanceErrors)) {
      const instanceData = {
        baseurl: key.replace("error:instance:", ""),
        error: value.error,
        time: value.time,
      };
      instanceData.type = this.findErrorType(value.error);

      if (errorTypes[instanceData.type] === undefined) {
        errorTypes[instanceData.type] = 0;
      } else {
        errorTypes[instanceData.type]++;
      }

      instanceErrors.push(instanceData);
    }

    // count each type
    // let errorTypes = {};
    // instanceErrors.forEach((instance) => {
    //   console.log("instance", instance);
    //   if (!errorTypes[instance.type]) {
    //     errorTypes[instance.type] = 0;
    //   } else {
    //     errorTypes[instance.type]++;
    //   }
    // });

    console.log("Error Types by Count");
    console.table(errorTypes);

    // logging.info("instanceErrors", instanceErrors.length, errorTypes);

    await this.splitter.storeInstanceErrors(instanceErrors);

    return instanceErrors;
  }

  // generate a list of all the instances that are suspicious and the reasons
  async outputSusList() {
    const output = [];

    for (const instance of this.instanceList) {
      // ignore instances that have no data
      const instanceSus = new Suspicions(instance);
      const susReason = await instanceSus.isSuspiciousReasons();

      if (susReason.length > 0) {
        output.push({
          users: instance.nodeData.usage.users.total,
          name: instance.siteData.site.name,
          base: instance.siteData.site.actor_id.split("/")[2],
          actor_id: instance.siteData.site.actor_id,
          metrics: instanceSus.metrics,
          reasons: susReason,
        });
      }
    }

    await this.splitter.storeSuspicousData(output);

    return output;
  }

  // generate a list of all the instances that are suspicious and the reasons
  async outputKBinMagazineList() {
    const output = [];

    // filter old data
    const filteredKBins = this.kbinData.filter((kbin) => {
      return kbin.lastCrawled > Date.now() - OUTPUT_MAX_AGE.MAGAZINE;
    });

    // logging.info(
    //   "KBin Magazines filteredKBins",
    //   this.kbinData.length,
    //   filteredKBins.length
    // );

    for (const kbin of filteredKBins) {
      output.push({
        actor_id: kbin.id,

        title: kbin.title, // display name
        name: kbin.name, // key username
        preferred: kbin.preferredUsername, // username ??

        baseurl: kbin.id.split("/")[2],

        summary: this.stripMarkdown(kbin.summary),
        sensitive: kbin.sensitive,
        postingRestrictedToMods: kbin.postingRestrictedToMods,

        icon: kbin.icon ? kbin.icon.url : null,
        published: kbin.published,
        updated: kbin.updated,
        followers: kbin.followerCount,

        time: kbin.lastCrawled,
      });
    }

    await this.splitter.storeKBinMagazineData(output);

    return filteredKBins;
  }
}
