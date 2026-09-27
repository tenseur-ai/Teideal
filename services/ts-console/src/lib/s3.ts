import { createReadStream } from "node:fs";
import {
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

const endpoint = () => process.env.AWS_ENDPOINT_URL_OVERRIDE;

interface CustomerCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

function endpointCredentials(): CustomerCredentials | undefined {
  // A local test endpoint still receives correctly signed SDK requests, but
  // must not require a developer machine to have real ambient AWS credentials.
  if (!endpoint()) return undefined;
  return { accessKeyId: "teideal-test", secretAccessKey: "teideal-test-secret" };
}

export async function assumeCustomerRole(region: string, roleArn: string): Promise<CustomerCredentials> {
  const client = new STSClient({
    region,
    endpoint: endpoint(),
    credentials: endpointCredentials(),
    maxAttempts: 1,
  });
  try {
    const response = await client.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `teideal-export-${Date.now()}`,
      DurationSeconds: 900,
    }));
    const credentials = response.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey) {
      throw new Error("AssumeRole returned no usable credentials");
    }
    return {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
      expiration: credentials.Expiration,
    };
  } finally {
    client.destroy();
  }
}

function s3Client(region: string, credentials: CustomerCredentials): S3Client {
  return new S3Client({
    region,
    credentials,
    endpoint: endpoint(),
    forcePathStyle: Boolean(endpoint()),
    maxAttempts: 1,
  });
}

export async function verifyS3Destination(region: string, roleArn: string, bucket: string): Promise<void> {
  const credentials = await assumeCustomerRole(region, roleArn);
  const client = s3Client(region, credentials);
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } finally {
    client.destroy();
  }
}

export async function uploadExportFiles(
  region: string,
  roleArn: string,
  bucket: string,
  objects: readonly { key: string; filePath: string; contentType: string }[],
): Promise<void> {
  const credentials = await assumeCustomerRole(region, roleArn);
  const client = s3Client(region, credentials);
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    for (const object of objects) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: object.key,
        Body: createReadStream(object.filePath),
        ContentType: object.contentType,
      }));
    }
  } finally {
    client.destroy();
  }
}
