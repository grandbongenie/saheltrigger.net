Scaleway bucket CORS required for archive playback/subtitles from `https://www.saheltrigger.net`:

```json
[
  {
    "AllowedOrigins": ["https://www.saheltrigger.net"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": [],
    "ExposeHeaders": ["Accept-Ranges", "Content-Range", "Content-Length", "Content-Type", "ETag"],
    "MaxAgeSeconds": 300
  }
]
```

Equivalent XML (S3 API):

```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://www.saheltrigger.net</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <ExposeHeader>Accept-Ranges</ExposeHeader>
    <ExposeHeader>Content-Range</ExposeHeader>
    <ExposeHeader>Content-Length</ExposeHeader>
    <ExposeHeader>Content-Type</ExposeHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>300</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```
