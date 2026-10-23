import React from 'react'

/** Generic chat-bubble mark for Facebook Pages / Messenger channels. */
const MessengerIcon = ({ width = 64, height = 64 }) => {
  return (
    <svg height={height} width={width} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <path style={{ fill: "#1877f2" }} d="M256 32C132.3 32 32 125.3 32 240.4c0 65.6 32.6 124.1 83.6 162.3V480l76.5-42c20.4 5.7 42 8.7 63.9 8.7 123.7 0 224-93.3 224-208.3S379.7 32 256 32"/>
      <path style={{ fill: "#ffffff" }} d="m279.4 309.9-57.1-60.8-111.3 60.8 122.4-130 58.5 60.8 109.9-60.8z"/>
    </svg>
  )
}

export default MessengerIcon
