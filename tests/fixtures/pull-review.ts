import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verificationFixture } from './verification.ts'
import { ownershipAuthority } from './ownership-authority.ts'
import { publicationFixture } from './publication.ts'
import { CoordinatorOwnership } from '../../src/ownership/lease.ts'
import { Publications } from '../../src/publication/runtime.ts'

/** Actual Git files, host check subprocesses, durable coordinator and independent HTTP provider contract. */
export async function pullReviewFixture(cleanup: (() => Promise<unknown>)[], event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' = 'APPROVE', native = false) {
  const h = await verificationFixture(cleanup, native), authority = await ownershipAuthority(cleanup), owner = new CoordinatorOwnership(authority.config)
  const publisher = await publicationFixture(cleanup, authority.resource, owner, 'github-pr-review', event)
  cleanup.push(() => owner.close()); await owner.start()
  const host = { store: h.store, library: h.library, lifetime: h.lifetime.signal, roots: () => [h.source], ownership: owner,
    connection: publisher.connection, verification: h.verification, reviews: h.reviews }
  const publications = new Publications(host); cleanup.push(() => publications.stop())
  const artifact = await h.artifact(), git = (...args: string[]) => execFileSync('git', args, { cwd: h.source, encoding: 'utf8' }).trim()
  git('init', '-q')
  const commit = () => {
    git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Review inputs')
    publisher.pull.head.sha = git('rev-parse', 'HEAD'); publisher.tree(git('rev-parse', 'HEAD^{tree}'))
  }
  await writeFile(join(h.source, 'dependency.txt'), 'baseline'); commit()
  const checked = await h.check(artifact), destination = (await publications.destinations()).items[0]!
  const pull = await publications.inspectPull(destination.id, destination.hash)
  const approval = { requestId: randomUUID(), revision: artifact.revision, hash: artifact.hash, destination: destination.id,
    destinationHash: destination.hash, checks: [checked.selection], pullHash: pull.hash }
  return { ...h, authority, owner, publisher, host, publications, artifact, checked, approval, pull, git, commit, destination }
}
