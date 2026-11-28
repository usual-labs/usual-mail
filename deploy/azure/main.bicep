@description('Your email. Public password claims stay closed until you prove ownership.')
@minLength(3)
@maxLength(254)
param ownerEmail string

@description('Your public IPv4 address for SSH, without /32.')
param adminIPv4 string

@description('Linux account used for SSH.')
param adminUsername string = 'mailadmin'

@description('Your SSH public key for the Linux account.')
param sshPublicKey string

@description('Choose a region with the selected VM size available.')
param location string = resourceGroup().location

@description('A Bsv2 size with an x64 CPU and SCSI data disks.')
@allowed(['Standard_B2ts_v2', 'Standard_B2ls_v2', 'Standard_B2s_v2'])
param vmSize string = 'Standard_B2ls_v2'

var prefix = 'usual-mail-${uniqueString(resourceGroup().id)}'
var nicName = '${prefix}-nic'
var subnetName = 'mail'

resource firewall 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${prefix}-firewall'
  location: location
  properties: {
    securityRules: [
      {
        name: 'web'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRanges: ['80', '443']
        }
      }
      {
        name: 'owner-ssh'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '${adminIPv4}/32'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
    ]
  }
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-network'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.77.0.0/24'] }
    subnets: [
      {
        name: subnetName
        properties: { addressPrefix: '10.77.0.0/24' }
      }
    ]
  }
}

resource address 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${prefix}-ip'
  location: location
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    dnsSettings: { domainNameLabel: prefix }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: nicName
  location: location
  properties: {
    networkSecurityGroup: { id: firewall.id }
    ipConfigurations: [
      {
        name: 'public'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: { id: address.id }
          subnet: { id: '${network.id}/subnets/${subnetName}' }
        }
      }
    ]
  }
}

// The ARM portal button consumes main.json, built from this file with "bicep build".
resource server 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: prefix
  location: location
  properties: {
    hardwareProfile: { vmSize: vmSize }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: { storageAccountType: 'StandardSSD_LRS' }
        deleteOption: 'Delete'
      }
      dataDisks: [
        {
          name: '${prefix}-mail'
          lun: 0
          createOption: 'Empty'
          diskSizeGB: 20
          managedDisk: { storageAccountType: 'StandardSSD_LRS' }
          deleteOption: 'Detach'
        }
      ]
    }
    osProfile: {
      computerName: 'usual-mail'
      adminUsername: adminUsername
      customData: base64(replace(replace(loadTextContent('bootstrap.sh'), '__OWNER_BASE64__', base64(ownerEmail)), '__DOMAIN__', address.properties.dnsSettings.fqdn!))
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
    }
    networkProfile: {
      networkInterfaces: [{ id: nic.id }]
    }
  }
}

output dashboard string = 'https://${address.properties.dnsSettings.fqdn}'
output sshHost string = '${adminUsername}@${address.properties.dnsSettings.fqdn}'
