# Lemmy Explorer (https://lemmyverse.net/)

This project provides a simple way to explore Lemmy Instances and Communities.

![List of Communities](./docs/images/communities.png)

The project consists of three modules:
1. Crawler (NodeJS, Redis)
2. Frontend (ReactJS, MUI Joy, TanStack)
3. Deploy (Amazon CDK v2)

## FAQ

**How does discovery work?**
 > It uses a [seed list of communities](https://github.com/tgxn/lemmy-explorer/blob/main/crawler/src/lib/const.js#L47) and scans the equivalent of the `/instances` federation lists, and then creates jobs to scan each of those servers.

**How long till my instance shows up?**
 > How long it takes to discover a new instance can vary depending on if you post content that's picked up by one of these servers.
 >
 > Since the crawler looks at lists of federated instances, we can't discover instances that aren't on those lists.
 >
 > Additionally, the lists are cached for 24 hours, so it can take up to 24 hours for an instance to show up after it's been discovered till it shows up.

**Can I use your data in my app/website/project?**
 > I do not own any of the data retrieved by the cralwer, it is available from public endpoints on the source instances.
 >
 > **Please don't hotlink the files on the public website, I'd prefer if you don't pull data from there directly in scripts.**
 >
 > Currently, the crawler dumps the data to the `./frontend/public/` folder. You can use that data in your project, you can find it in [`./frontend/public/`](./frontend/public/).
 >
 > *Further information will be available in [#89](https://github.com/tgxn/lemmy-explorer/issues/89) when this changes.*

## Crawler


[Crawler README](./crawler/README.md)

### Data

Static dumps from the last time I ran the dump are stored in [`./frontend/public/`](./frontend/public/).

- `communities.json` - list of all communities
- `instances.json` - list of all instances
- `overview.json` - metadata and counts


## 2. Frontend

[Frontend README](./frontend/README.md)



## Deploy

The deploy is an Amazon CDK v2 project that deploys the crawler and frontend to AWS.

`config.example.json` has the configuration for the deploy.

then run `cdk deploy --all` to deploy the frontend to AWS.




## Similar Sites

- https://browse.feddit.de/
- https://join-lemmy.org/instances
- https://github.com/maltfield/awesome-lemmy-instances
- https://lemmymap.feddit.de/
- https://browse.toast.ooo/

## Lemmy Stats Pages
- https://lemmy.fediverse.observer/dailystats
- https://the-federation.info/platform/73
- https://fedidb.org/

## Thanks / Related Lemmy Tools

- https://github.com/db0/fediseer
- https://github.com/LemmyNet/lemmy-stats-crawler

# Credits

Logo made by Andy Cuccaro (@andycuccaro) under the CC-BY-SA 4.0 license.

