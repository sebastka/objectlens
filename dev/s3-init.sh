#!/bin/sh
# Demo content and restricted users for the development RustFS (compose.yaml, s3-init).
# Safe to run again. Runs in the rustfs/rc image:
#   demo      versioned bucket with a few files
#   archive   unversioned bucket
#   reader    read-only user (secret: reader-secret), everything greyed out except reading
#   dropbox   may read "demo" but write and delete only under demo/inbox/ (secret: dropbox-secret)
set -eu

rc alias set local "$S3_URL" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null

for b in demo archive; do
  rc bucket create "local/$b" 2>/dev/null || true
done
rc bucket version enable local/demo >/dev/null

if ! rc object stat local/demo/README.md >/dev/null 2>&1; then
  printf '# Demo bucket\n\nCreated by dev/s3-init.sh.\n' | rc pipe local/demo/README.md
  printf '{\n  "hello": "world"\n}\n' | rc pipe local/demo/docs/example.json
  printf 'id,name\n1,alpha\n2,beta\n' | rc pipe local/demo/docs/data.csv
  printf 'first version\n' | rc pipe local/demo/docs/versioned.txt
  printf 'second version\n' | rc pipe local/demo/docs/versioned.txt
  printf 'drop files here\n' | rc pipe local/demo/inbox/README.txt
  printf 'old report\n' | rc pipe local/archive/2025/report.txt
fi

cat > /tmp/reader.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListAllMyBuckets",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:GetObjectTagging",
        "s3:GetObjectVersionTagging"
      ],
      "Resource": ["arn:aws:s3:::*"]
    }
  ]
}
JSON

cat > /tmp/dropbox.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListAllMyBuckets", "s3:GetBucketLocation", "s3:GetBucketVersioning"],
      "Resource": ["arn:aws:s3:::*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:ListBucketVersions"],
      "Resource": ["arn:aws:s3:::demo"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectTagging"],
      "Resource": ["arn:aws:s3:::demo/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject", "s3:PutObjectTagging"],
      "Resource": ["arn:aws:s3:::demo/inbox/*"]
    }
  ]
}
JSON

for u in reader dropbox; do
  rc admin user add local "$u" "$u-secret" >/dev/null 2>&1 || true
  rc admin policy rm local "objectlens-$u" >/dev/null 2>&1 || true
  rc admin policy create local "objectlens-$u" "/tmp/$u.json" >/dev/null
  rc admin policy attach local "objectlens-$u" --user "$u" >/dev/null 2>&1 || true
done

echo "S3 ready: buckets demo (versioned) and archive; users reader/reader-secret and dropbox/dropbox-secret"
