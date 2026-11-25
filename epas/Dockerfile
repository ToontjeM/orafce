# EDB Postgres Advanced Server 18 in Oracle-compatible mode. This is "path B".
# The cluster is initialised with --redwood-like, which turns on the Oracle
# behaviours that cannot be switched on later (DATE with time, '' = NULL, ...).
FROM almalinux:9

ENV AS_BIN=/usr/edb/as18/bin \
    PGDATA=/var/lib/edb/as18/lab

# The EDB subscription token is a BuildKit secret: it never lands in a layer,
# and the repo file that embeds it is deleted in the same RUN.
RUN --mount=type=secret,id=repo_token bash -c 'set -eu; \
    T=$(cat /run/secrets/repo_token); test -n "$T"; \
    curl -1sLf "https://downloads.enterprisedb.com/$T/enterprise/setup.rpm.sh" | bash >/dev/null 2>&1; \
    dnf install -y glibc-langpack-en edb-as18-server; \
    dnf clean all; rm -rf /var/cache/dnf /etc/yum.repos.d/*enterprisedb*.repo'

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER enterprisedb
EXPOSE 5444
CMD ["/entrypoint.sh"]
