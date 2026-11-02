/**
 * The sample PDF submitted with the GST invoice and till bill templates: Meta
 * reviews a media header with a sample of it, and each message then carries
 * the order's own invoice or bill. Embedded because the server image ships
 * only the compiled code. A one-page A4 tax invoice in Helvetica, made with
 * pdfkit.
 */
export const SAMPLE_INVOICE_PDF = Buffer.from(
    [
        'JVBERi0xLjMKJf////8KNyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9NZWRpYUJveCBbMCAwIDU5NS4yOCA4',
        'NDEuODldCi9Db250ZW50cyA1IDAgUgovUmVzb3VyY2VzIDYgMCBSCi9Vc2VyVW5pdCAxCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Q',
        'cm9jU2V0IFsvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJXQovRm9udCA8PAovRjIgOCAwIFIKL0YxIDkgMCBSCj4+',
        'Ci9Db2xvclNwYWNlIDw8Cj4+Cj4+CmVuZG9iago1IDAgb2JqCjw8Ci9MZW5ndGggNTIxCi9GaWx0ZXIgL0ZsYXRlRGVjb2RlCj4+',
        'CnN0cmVhbQp4nJ2VTWvcQAyG7/4V8wcy0eerGVj2EPoBvbXsrfTQem3oIYUS6O8vM3ESnM2267XBYA2W9OiVZE6UKN1wolSMc6lp',
        'vB9+D/yW+e6w2Dk5UoTkCqTD/XD7QRKXdJiHrzu3fSqUduAoQqiY9sko7QL7pM0+o0Lh+0Tf0uHT8P4wfB5u301/fo7Tl493aXwY',
        'KOurK11mehh/XZi7Uy6wx9w5MS25KxjHIIxw/b5PTmknFIYCFwqBgzE+UclCJf5C1c5ChcBhYWBo+xbWvcxC3YOiVeYID40WMVo1',
        '2NNOpn9Vpad/OaJEJnmRhx8R7awgQu2E24njCIGHrNL5f1hWZBOq1dbh+Tm8kJBVmxyPXSJHFUV/hsxKy226NXQjZsvKm4Ct6fSq',
        'Fy/A5JIL1VrXMdeUnYtshob1t265goo4e7UTrLmp01oQdoVSxXOorp2v8xdVvlYJlJJLlJOcBRVjG66ngdjoutas1Wot6wiv2osx',
        'gXsve9pFXarEV2BAs9kbI9R6BseNDq1Gr/k5r4wj5nBMYVek6pTVT8bNxraq4JiE8CN6n9z0WTCwUNvQurUwFo3Dz4V0CX3ZZugb',
        'VEVGVQ2tMmnVegWfRsZJn1q4uglJUReXrX6tIFeqZ5y/CcLKHWJ72RoEl+w4Uf75jzn3P8a4WQ/kUDvrXUJl2YCLEtY06BC0ivUX',
        '2iimwAplbmRzdHJlYW0KZW5kb2JqCjExIDAgb2JqCihDb2xsYWJvKQplbmRvYmoKMTIgMCBvYmoKKENvbGxhYm8pCmVuZG9iagox',
        'MyAwIG9iagooRDoyMDI2MTAyNjA4NTE0M1opCmVuZG9iagoxNCAwIG9iagooU2FtcGxlIHRheCBpbnZvaWNlKQplbmRvYmoKMTAg',
        'MCBvYmoKPDwKL1Byb2R1Y2VyIDExIDAgUgovQ3JlYXRvciAxMiAwIFIKL0NyZWF0aW9uRGF0ZSAxMyAwIFIKL1RpdGxlIDE0IDAg',
        'Ugo+PgplbmRvYmoKOSAwIG9iago8PAovVHlwZSAvRm9udAovQmFzZUZvbnQgL0hlbHZldGljYQovU3VidHlwZSAvVHlwZTEKL0Vu',
        'Y29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCjggMCBvYmoKPDwKL1R5cGUgL0ZvbnQKL0Jhc2VGb250IC9IZWx2ZXRp',
        'Y2EtQm9sZAovU3VidHlwZSAvVHlwZTEKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCjQgMCBvYmoKPDwKPj4K',
        'ZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCi9OYW1lcyAyIDAgUgo+PgplbmRvYmoKMSAwIG9i',
        'ago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDEKL0tpZHMgWzcgMCBSXQo+PgplbmRvYmoKMiAwIG9iago8PAovRGVzdHMgPDwKICAv',
        'TmFtZXMgWwpdCj4+Cj4+CmVuZG9iagp4cmVmCjAgMTUKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAxMzQ0IDAwMDAwIG4gCjAw',
        'MDAwMDE0MDEgMDAwMDAgbiAKMDAwMDAwMTI4MiAwMDAwMCBuIAowMDAwMDAxMjYxIDAwMDAwIG4gCjAwMDAwMDAyNTQgMDAwMDAg',
        'biAKMDAwMDAwMDEzNyAwMDAwMCBuIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDExNTkgMDAwMDAgbiAKMDAwMDAwMTA2MiAw',
        'MDAwMCBuIAowMDAwMDAwOTcyIDAwMDAwIG4gCjAwMDAwMDA4NDcgMDAwMDAgbiAKMDAwMDAwMDg3MyAwMDAwMCBuIAowMDAwMDAw',
        'ODk5IDAwMDAwIG4gCjAwMDAwMDA5MzUgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSAxNQovUm9vdCAzIDAgUgovSW5mbyAxMCAw',
        'IFIKL0lEIFs8MWIxNjVhMWIzZTQzNTY3NDEyNzc3ZmUyY2QxOWQ0MDE+IDwxYjE2NWExYjNlNDM1Njc0MTI3NzdmZTJjZDE5ZDQw',
        'MT5dCj4+CnN0YXJ0eHJlZgoxNDQ4CiUlRU9GCg==',
    ].join(''),
    'base64',
);

export const SAMPLE_INVOICE_FILENAME = 'sample-invoice.pdf';
