import FaceLiveness
import Foundation

// The guest credentials the app got from Cognito in JS, handed to the SDK as
// they are. No Amplify Auth and no Amplify.configure: the SDK only asks this
// provider. The values live in memory for one capture and are never written
// anywhere.
struct StaticCredentials: AWSTemporaryCredentials {
  let accessKeyId: String
  let secretAccessKey: String
  let sessionToken: String
  let expiration: Date
}

struct StaticCredentialsProvider: AWSCredentialsProvider {
  let credentials: StaticCredentials

  func fetchAWSCredentials() async throws -> AWSCredentials {
    return credentials
  }
}
